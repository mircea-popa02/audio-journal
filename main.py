import os
import aiohttp
from fastapi import FastAPI, BackgroundTasks, UploadFile, status
from fastapi.responses import JSONResponse

app = FastAPI()

# Point these to your internal Docker service hostnames
WHISPER_URL = os.getenv("WHISPER_URL", "http://whisper:9000/asr")
MEMOS_URL = os.getenv("MEMOS_URL", "http://memos:5230/api/v1/memo")
MEMOS_TOKEN = os.getenv("MEMOS_TOKEN", "your_api_token_here")

async def process_and_upload_journal_memo(file_bytes: bytes, filename: str):
    """
    Background worker: Transcribes audio, applies custom formatting, and pushes the log to Memos.
    """
    # 1. Hand off to Whisper
    async with aiohttp.ClientSession() as session:
        form = aiohttp.FormData()
        form.add_field('audio_file', file_bytes, filename=filename)
        
        async with session.post(WHISPER_URL, data=form) as whisper_resp:
            if whisper_resp.status != 200:
                print(f"Whisper transcription failed: {whisper_resp.status}")
                return
                
            whisper_data = await whisper_resp.json()
            transcription = whisper_data.get("text", "")

    # 2. Format the journal memo 
    # (Adjust this to match however you like your daily logs structured)
    formatted_content = f"# Audio Journal Log\n\n{transcription.strip()}"

    # 3. Push the finalized entry to the Memos API
    headers = {
        "Authorization": f"Bearer {MEMOS_TOKEN}",
        "Content-Type": "application/json"
    }
    memo_payload = {"content": formatted_content}
    
    async with aiohttp.ClientSession() as session:
        async with session.post(MEMOS_URL, json=memo_payload, headers=headers) as memos_resp:
            if memos_resp.status != 200:
                print(f"Failed to upload to Memos: {memos_resp.status}")

@app.post("/webhook/audio")
async def handle_ios_upload(background_tasks: BackgroundTasks, file: UploadFile):
    # CRITICAL: Read the file bytes into memory before the connection closes
    audio_data = await file.read()
    
    # Hand the raw bytes and filename off to the background task
    background_tasks.add_task(process_and_upload_journal_memo, audio_data, file.filename)
    
    # Instantly sever the connection so the iOS Shortcut can complete successfully
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"message": "Audio accepted. Background processing initiated."}
    )