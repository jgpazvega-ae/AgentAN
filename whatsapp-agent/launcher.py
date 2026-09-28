"""
AN Mobility Group — WhatsApp AI Agent
Launcher con interfaz gráfica para Windows
"""

import os
import sys
import threading
import webbrowser
import tkinter as tk
from tkinter import messagebox
from pathlib import Path

# ── Rutas ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
ENV_FILE = BASE_DIR / ".env"

# ── Colores ─────────────────────────────────────────────────────────────────────
BG = "#1a1a2e"
BG2 = "#16213e"
ACCENT = "#0f3460"
GREEN = "#00d4aa"
WHITE = "#e0e0e0"
GRAY = "#888"
RED = "#ff6b6b"
FONT = ("Segoe UI", 10)
FONT_BOLD = ("Segoe UI", 10, "bold")
FONT_TITLE = ("Segoe UI", 16, "bold")
FONT_SMALL = ("Segoe UI", 9)


def read_env() -> dict:
    """Lee el archivo .env y retorna un dict con las variables."""
    if not ENV_FILE.exists():
        return {}
    data = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            data[k.strip()] = v.strip()
    return data


def write_env(config: dict) -> None:
    """Escribe el archivo .env con las variables del dict."""
    lines = [
        "# AN Mobility Group — WhatsApp AI Agent",
        f"WHATSAPP_TOKEN={config.get('WHATSAPP_TOKEN', '')}",
        f"WHATSAPP_PHONE_ID={config.get('WHATSAPP_PHONE_ID', '')}",
        f"WEBHOOK_VERIFY_TOKEN={config.get('WEBHOOK_VERIFY_TOKEN', 'anmobility2025')}",
        f"ANTHROPIC_API_KEY={config.get('ANTHROPIC_API_KEY', '')}",
        f"CLAUDE_MODEL={config.get('CLAUDE_MODEL', 'claude-sonnet-4-6')}",
        "PORT=8000",
        "DEBUG=false",
    ]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def is_configured() -> bool:
    cfg = read_env()
    return bool(
        cfg.get("WHATSAPP_TOKEN")
        and cfg.get("WHATSAPP_PHONE_ID")
        and cfg.get("ANTHROPIC_API_KEY")
    )


_server_process = None


def stop_server():
    global _server_process
    if _server_process:
        _server_process.terminate()
        _server_process = None


# ── Ventana principal ───────────────────────────────────────────────────────────
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("AN Mobility Group — WhatsApp Agent")
        self.resizable(False, False)
        self.configure(bg=BG)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        w, h = 560, 600
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"{w}x{h}+{(sw-w)//2}+{(sh-h)//2}")

        self._build_state()

        if is_configured():
            self._show_main()
        else:
            self._show_setup(page=0)

    def _build_state(self):
        self._meta_token = None
        self._meta_phone = None
        self._webhook_token = None
        self._anthropic_key = None

    def _clear(self):
        for w in self.winfo_children():
            w.destroy()

    def _header(self, subtitle=""):
        frame = tk.Frame(self, bg=ACCENT, pady=18)
        frame.pack(fill="x")
        tk.Label(frame, text="AN Mobility Group", font=FONT_TITLE,
                 bg=ACCENT, fg=WHITE).pack()
        tk.Label(frame, text="WhatsApp AI Agent", font=FONT_SMALL,
                 bg=ACCENT, fg=GREEN).pack()
        if subtitle:
            tk.Label(frame, text=subtitle, font=FONT_SMALL,
                     bg=ACCENT, fg=GRAY).pack(pady=(4, 0))

    def _btn(self, parent, text, cmd, color=GREEN, fg=BG, width=22):
        return tk.Button(
            parent, text=text, command=cmd, font=FONT_BOLD,
            bg=color, fg=fg, activebackground=color, activeforeground=fg,
            bd=0, relief="flat", padx=10, pady=8, width=width, cursor="hand2",
        )

    def _labeled_entry(self, parent, label, show=""):
        frame = tk.Frame(parent, bg=BG2, pady=4)
        frame.pack(fill="x", padx=30, pady=4)
        tk.Label(frame, text=label, font=FONT_SMALL, bg=BG2, fg=GRAY, anchor="w").pack(fill="x")
        var = tk.StringVar()
        tk.Entry(frame, textvariable=var, show=show, font=FONT,
                 bg="#0d1117", fg=WHITE, insertbackground=WHITE,
                 relief="flat", bd=0, highlightthickness=1,
                 highlightbackground=ACCENT, highlightcolor=GREEN).pack(fill="x", ipady=6)
        return var

    # ── Setup wizard ────────────────────────────────────────────────────────────

    def _show_setup(self, page=0):
        self._clear()
        [self._page_welcome, self._page_meta, self._page_claude][page]()

    def _page_welcome(self):
        self._header("Configuración inicial")
        body = tk.Frame(self, bg=BG, pady=20)
        body.pack(fill="both", expand=True)
        tk.Label(body, text="¡Bienvenido!", font=FONT_BOLD, bg=BG, fg=GREEN).pack(pady=(20, 4))
        tk.Label(body, text=(
            "Este asistente te guiará para conectar el agente de IA\n"
            "con tu número de WhatsApp Business.\n\n"
            "Necesitarás:\n"
            "  • Token de Meta (WhatsApp Business API)\n"
            "  • Phone ID de tu número\n"
            "  • API Key de Anthropic (Claude)\n\n"
            "Solo debes configurarlo una vez."
        ), font=FONT, bg=BG, fg=WHITE, justify="left").pack(padx=40)
        foot = tk.Frame(self, bg=BG2, pady=12)
        foot.pack(fill="x", side="bottom")
        self._btn(foot, "Comenzar →", lambda: self._show_setup(1)).pack()

    def _page_meta(self):
        self._header("Paso 1 — Credenciales de Meta")
        body = tk.Frame(self, bg=BG2)
        body.pack(fill="both", expand=True, pady=10)
        tk.Label(body,
                 text="Obtén estos datos en developers.facebook.com\n→ Tu App → WhatsApp → API Setup",
                 font=FONT_SMALL, bg=BG2, fg=GRAY, justify="center").pack(pady=(10, 4))
        cfg = read_env()
        self._meta_token = self._labeled_entry(body, "WHATSAPP_TOKEN  (token permanente de Meta)", show="•")
        self._meta_phone = self._labeled_entry(body, "WHATSAPP_PHONE_ID  (ID del número de teléfono)")
        self._webhook_token = self._labeled_entry(body, "WEBHOOK_VERIFY_TOKEN  (invéntalo tú, ej: anmobility2025)")
        self._meta_token.set(cfg.get("WHATSAPP_TOKEN", ""))
        self._meta_phone.set(cfg.get("WHATSAPP_PHONE_ID", ""))
        self._webhook_token.set(cfg.get("WEBHOOK_VERIFY_TOKEN", "anmobility2025"))
        tk.Button(body, text="Abrir Meta for Developers ↗", font=FONT_SMALL,
                  bg=BG2, fg=GREEN, bd=0, cursor="hand2",
                  command=lambda: webbrowser.open("https://developers.facebook.com/")).pack(pady=6)
        foot = tk.Frame(self, bg=BG2, pady=12)
        foot.pack(fill="x", side="bottom")
        f = tk.Frame(foot, bg=BG2)
        f.pack()
        self._btn(f, "← Atrás", lambda: self._show_setup(0), color=ACCENT, fg=WHITE, width=10).pack(side="left", padx=6)
        self._btn(f, "Siguiente →", self._next_from_meta, width=14).pack(side="left", padx=6)

    def _next_from_meta(self):
        if not self._meta_token.get().strip() or not self._meta_phone.get().strip():
            messagebox.showwarning("Campos requeridos", "Por favor completa el Token y el Phone ID de Meta.")
            return
        self._show_setup(2)

    def _page_claude(self):
        self._header("Paso 2 — API Key de Claude (Anthropic)")
        body = tk.Frame(self, bg=BG2)
        body.pack(fill="both", expand=True, pady=10)
        tk.Label(body,
                 text="Obtén tu clave en console.anthropic.com\n→ API Keys → Create Key",
                 font=FONT_SMALL, bg=BG2, fg=GRAY, justify="center").pack(pady=(10, 4))
        cfg = read_env()
        self._anthropic_key = self._labeled_entry(body, "ANTHROPIC_API_KEY  (empieza con sk-ant-...)", show="•")
        self._anthropic_key.set(cfg.get("ANTHROPIC_API_KEY", ""))
        tk.Button(body, text="Abrir console.anthropic.com ↗", font=FONT_SMALL,
                  bg=BG2, fg=GREEN, bd=0, cursor="hand2",
                  command=lambda: webbrowser.open("https://console.anthropic.com/")).pack(pady=6)
        foot = tk.Frame(self, bg=BG2, pady=12)
        foot.pack(fill="x", side="bottom")
        f = tk.Frame(foot, bg=BG2)
        f.pack()
        self._btn(f, "← Atrás", lambda: self._show_setup(1), color=ACCENT, fg=WHITE, width=10).pack(side="left", padx=6)
        self._btn(f, "Guardar y arrancar", self._save_and_start, width=18).pack(side="left", padx=6)

    def _save_and_start(self):
        if not self._anthropic_key.get().strip():
            messagebox.showwarning("Campo requerido", "Por favor ingresa tu API Key de Anthropic.")
            return
        write_env({
            "WHATSAPP_TOKEN": self._meta_token.get().strip(),
            "WHATSAPP_PHONE_ID": self._meta_phone.get().strip(),
            "WEBHOOK_VERIFY_TOKEN": self._webhook_token.get().strip() or "anmobility2025",
            "ANTHROPIC_API_KEY": self._anthropic_key.get().strip(),
            "CLAUDE_MODEL": "claude-sonnet-4-6",
        })
        self._show_main(first_time=True)

    # ── Pantalla principal ───────────────────────────────────────────────────────

    def _show_main(self, first_time=False):
        self._clear()
        self._header()
        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=30, pady=10)

        status_frame = tk.Frame(body, bg=BG2, pady=12, padx=16)
        status_frame.pack(fill="x", pady=8)
        tk.Label(status_frame, text="Estado del agente", font=FONT_BOLD, bg=BG2, fg=WHITE).pack(anchor="w")
        self._status_dot = tk.Label(status_frame, text="⬤  Iniciando...", font=FONT, bg=BG2, fg=GRAY)
        self._status_dot.pack(anchor="w", pady=4)

        url_frame = tk.Frame(body, bg=BG2, pady=12, padx=16)
        url_frame.pack(fill="x", pady=8)
        tk.Label(url_frame, text="URL del Webhook", font=FONT_BOLD, bg=BG2, fg=WHITE).pack(anchor="w")
        self._url_var = tk.StringVar(value="http://localhost:8000/webhook")
        tk.Entry(url_frame, textvariable=self._url_var, font=FONT_SMALL,
                 bg="#0d1117", fg=GREEN, relief="flat", state="readonly",
                 readonlybackground="#0d1117").pack(fill="x", ipady=5, pady=4)
        tk.Label(url_frame,
                 text="Para recibir mensajes necesitas una URL pública.\n"
                      "Abre ngrok en otra ventana:   ngrok http 8000",
                 font=FONT_SMALL, bg=BG2, fg=GRAY, justify="left").pack(anchor="w")

        log_frame = tk.Frame(body, bg=BG2, pady=8, padx=12)
        log_frame.pack(fill="both", expand=True, pady=8)
        tk.Label(log_frame, text="Actividad reciente", font=FONT_BOLD, bg=BG2, fg=WHITE).pack(anchor="w")
        self._log = tk.Text(log_frame, height=8, font=("Consolas", 9),
                            bg="#0d1117", fg=WHITE, relief="flat",
                            state="disabled", wrap="word")
        self._log.pack(fill="both", expand=True, pady=4)

        btn_frame = tk.Frame(body, bg=BG)
        btn_frame.pack(fill="x", pady=4)
        self._btn(btn_frame, "⚙  Reconfigurar", lambda: self._show_setup(0), color=ACCENT, fg=WHITE, width=16).pack(side="left")
        self._btn(btn_frame, "✕  Detener agente", self._on_close, color=RED, fg=WHITE, width=16).pack(side="right")

        threading.Thread(target=self._run_server, daemon=True).start()
        threading.Thread(target=self._attach_log_handler, daemon=True).start()

    def _run_server(self):
        import uvicorn
        cfg = read_env()
        for k, v in cfg.items():
            os.environ.setdefault(k, v)
        self.after(1500, self._set_running)
        try:
            uvicorn.run("app.main:app", host="0.0.0.0", port=8000, log_level="info")
        except Exception as e:
            self.after(0, lambda err=e: self._log_line(f"Error: {err}"))
            self.after(0, lambda: self._status_dot.config(text="⬤  Error", fg=RED))

    def _set_running(self):
        self._status_dot.config(text="⬤  Activo — escuchando en el puerto 8000", fg=GREEN)
        self._log_line("Agente iniciado. Webhook listo en http://localhost:8000/webhook")

    def _attach_log_handler(self):
        import logging
        class TkHandler(logging.Handler):
            def __init__(self_, callback):
                super().__init__()
                self_.callback = callback
            def emit(self_, record):
                msg = self_.format(record)
                self.after(0, lambda m=msg: self._log_line(m))
        handler = TkHandler(self._log_line)
        handler.setLevel(logging.INFO)
        for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
            logging.getLogger(name).addHandler(handler)

    def _log_line(self, text: str):
        self._log.config(state="normal")
        self._log.insert("end", text + "\n")
        self._log.see("end")
        self._log.config(state="disabled")

    def _on_close(self):
        if messagebox.askokcancel("Salir", "¿Detener el agente y cerrar?"):
            stop_server()
            self.destroy()


if __name__ == "__main__":
    if "--server" in sys.argv:
        import uvicorn
        cfg = read_env()
        for k, v in cfg.items():
            os.environ.setdefault(k, v)
        uvicorn.run("app.main:app", host="0.0.0.0", port=8000, log_level="info")
    else:
        App().mainloop()
