# backend/app.py (updated)
import os, uuid, json
from fastapi import FastAPI, WebSocket, Request, HTTPException, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from gtts import gTTS

from model_server import ModelServer
import traceback

MODEL_PATH = "models/kannada_mobilenetv2_best.pth"
IDX_PATH = "models/idx2label.json"
IMG_SIZE = 128

os.makedirs("static/tts", exist_ok=True)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

model_server = ModelServer(MODEL_PATH, IDX_PATH, img_size=IMG_SIZE)

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.websocket("/ws/predict")
async def ws_predict(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_json()
            frame = data.get("frame")
            if not frame:
                await ws.send_json({"error":"no frame"})
                continue
            res = model_server.predict(frame)
            await ws.send_json({"prediction": res["label"], "score": res["score"], "index": res["index"]})
    except Exception:
        # Log the exception server-side so we can see why connections close
        print("WebSocket /ws/predict error:")
        traceback.print_exc()
        try:
            await ws.close()
        except Exception:
            pass

# Accepts JSON body { "text": "..." } or form field 'text'
@app.post("/tts")
async def tts_generate(request: Request):
    """
    Generate TTS using gTTS (fallback). Accepts JSON or form data.
    Returns {"url": "/static/tts/<uuid>.mp3"}
    """
    text = None
    # try JSON
    try:
        data = await request.json()
        if isinstance(data, dict) and "text" in data:
            text = data.get("text")
    except Exception:
        pass

    # try form fallback
    if not text:
        try:
            form = await request.form()
            text = form.get("text")
        except Exception:
            pass

    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    # sanitize short text
    text = text.strip()
    if len(text) == 0:
        raise HTTPException(status_code=400, detail="Empty text")

    uid = str(uuid.uuid4())
    filename = f"static/tts/{uid}.mp3"
    # generate gTTS (Kannada lang 'kn')
    try:
        tts = gTTS(text=text, lang="kn")
        tts.save(filename)
    except Exception as e:
        # cleanup possible partial file
        if os.path.exists(filename):
            try: os.remove(filename)
            except: pass
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {e}")

    return {"url": f"/{filename}"}

# Previous version of backend/app.py

# from fastapi import FastAPI, WebSocket
# from fastapi.middleware.cors import CORSMiddleware
# from model_server import ModelServer

# MODEL_PATH = "models/kannada_mobilenetv2_best.pth"
# IDX_PATH = "models/idx2label.json"

# model = ModelServer(MODEL_PATH, IDX_PATH)

# app = FastAPI()

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],
#     allow_headers=["*"],
#     allow_methods=["*"],
# )

# @app.websocket("/ws/predict")
# async def ws_predict(ws: WebSocket):
#     await ws.accept()
#     while True:
#         data = await ws.receive_json()
#         frame = data["frame"]

#         letter, score = model.predict(frame)

#         await ws.send_json({
#             "prediction": letter,
#             "score": score
#         })
