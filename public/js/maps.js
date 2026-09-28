// Selector de lugares con Google Maps: buscar dirección o tocar el mapa.
// Si no hay llave de Google Maps, se usa un campo de texto normal (y se pueden
// pegar coordenadas o un enlace de Google Maps).
let mapsPromise = null;

function loadGoogleMaps(key) {
  if (!key) return Promise.resolve(null);
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve) => {
    window.__onMapsLoaded = () => resolve(window.google);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=places&language=es&loading=async&callback=__onMapsLoaded`;
    s.async = true;
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return mapsPromise;
}

// Extrae "lat,lng" de texto pegado: "19.43,-99.13", enlaces con @lat,lng o ?q=lat,lng.
function parseCoords(text) {
  const m = String(text).match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const DEFAULT_CENTER = { lat: 23.6345, lng: -102.5528 }; // centro aproximado de México

class PlacePicker {
  constructor(root, { apiKey, placeholder }) {
    this.root = root;
    this.value = { address: '', lat: null, lng: null };
    this.root.classList.add('place-picker');
    this.root.innerHTML = `
      <div class="search"></div>
      <input class="address" placeholder="${esc(placeholder || 'Dirección')}" required>
      <div class="coords"></div>
      <div class="map hidden"></div>`;
    this.addressInput = root.querySelector('.address');
    this.coordsEl = root.querySelector('.coords');
    this.addressInput.addEventListener('input', () => {
      this.value.address = this.addressInput.value;
      // Si pegan coordenadas o un enlace de Maps, se toman las coordenadas.
      const c = parseCoords(this.addressInput.value);
      if (c) {
        // Un enlace pegado no es legible para el chofer: se reemplaza por la ubicación.
        if (/^https?:\/\//i.test(this.addressInput.value.trim())) this.setAddress(`Ubicación ${c.lat}, ${c.lng}`);
        this.setPoint(c.lat, c.lng, Boolean(this.geocoder), this.map ? 16 : undefined);
      }
    });
    this.ready = this.initMap(apiKey);
  }

  async initMap(apiKey) {
    const google = await loadGoogleMaps(apiKey);
    if (!google) {
      this.coordsEl.textContent = 'Escribe la dirección. También puedes pegar un enlace o coordenadas de Google Maps.';
      return;
    }
    const { Map } = await google.maps.importLibrary('maps');
    const places = await google.maps.importLibrary('places');
    const mapEl = this.root.querySelector('.map');
    mapEl.classList.remove('hidden');
    this.map = new Map(mapEl, {
      center: DEFAULT_CENTER,
      zoom: 5,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
    });
    this.marker = new google.maps.Marker({ map: this.map, draggable: true, visible: false });
    this.geocoder = new google.maps.Geocoder();

    // Buscador de lugares (Places API New).
    if (places.PlaceAutocompleteElement) {
      const ac = new places.PlaceAutocompleteElement({});
      ac.setAttribute('placeholder', 'Buscar dirección o negocio…');
      this.root.querySelector('.search').append(ac);
      const onPlace = async (place) => {
        await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
        const name = place.displayName && !String(place.formattedAddress || '').startsWith(place.displayName) ? `${place.displayName}, ` : '';
        this.setAddress(`${name}${place.formattedAddress || ''}`);
        this.setPoint(place.location.lat(), place.location.lng(), false, 16);
      };
      ac.addEventListener('gmp-select', (e) => onPlace(e.placePrediction.toPlace()));
      ac.addEventListener('gmp-placeselect', (e) => onPlace(e.place)); // versiones anteriores
    }

    this.coordsEl.textContent = 'Busca la dirección o toca el mapa para marcar el punto exacto. Puedes arrastrar el marcador.';
    this.map.addListener('click', (e) => this.setPoint(e.latLng.lat(), e.latLng.lng(), true));
    this.marker.addListener('dragend', (e) => this.setPoint(e.latLng.lat(), e.latLng.lng(), true));
    if (this.value.lat != null) this.setPoint(this.value.lat, this.value.lng, false, 15);
  }

  setAddress(address) {
    this.value.address = address;
    this.addressInput.value = address;
  }

  setPoint(lat, lng, reverseGeocode, zoom) {
    this.value.lat = Math.round(lat * 1e6) / 1e6;
    this.value.lng = Math.round(lng * 1e6) / 1e6;
    this.coordsEl.textContent = `Punto marcado: ${this.value.lat}, ${this.value.lng}`;
    if (this.marker) {
      const pos = { lat: this.value.lat, lng: this.value.lng };
      this.marker.setPosition(pos);
      this.marker.setVisible(true);
      if (zoom) {
        this.map.setCenter(pos);
        this.map.setZoom(zoom);
      }
    }
    if (reverseGeocode && this.geocoder) {
      this.geocoder
        .geocode({ location: { lat: this.value.lat, lng: this.value.lng } })
        .then(({ results }) => results[0] && this.setAddress(results[0].formatted_address))
        .catch(() => {});
    }
  }

  setValue({ address, lat, lng }) {
    this.setAddress(address || '');
    this.value.lat = null;
    this.value.lng = null;
    this.coordsEl.textContent = '';
    if (lat != null && lng != null) this.setPoint(lat, lng, false, 15);
    else if (this.marker) {
      this.marker.setVisible(false);
      this.map.setCenter(DEFAULT_CENTER);
      this.map.setZoom(5);
    }
  }

  getValue() {
    return { ...this.value, address: this.addressInput.value.trim() };
  }
}
