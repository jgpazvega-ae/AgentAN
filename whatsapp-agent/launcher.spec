# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec para AN Mobility Group WhatsApp Agent
# Genera: dist/ANMobilityAgent.exe

block_cipher = None

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=[
        "uvicorn", "uvicorn.logging", "uvicorn.loops", "uvicorn.loops.auto",
        "uvicorn.loops.asyncio", "uvicorn.protocols", "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan", "uvicorn.lifespan.on",
        "fastapi", "starlette", "starlette.routing", "starlette.middleware",
        "starlette.responses",
        "anthropic", "anthropic._client", "anthropic.resources",
        "httpx", "httpcore", "h11", "anyio", "anyio._backends._asyncio",
        "dotenv", "python_dotenv",
        "app", "app.main", "app.agent", "app.whatsapp", "app.config",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["matplotlib", "numpy", "pandas", "PIL", "PyQt5"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, a.binaries, a.zipfiles, a.datas, [],
    name="ANMobilityAgent",
    debug=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    # icon="assets/icon.ico",
)
