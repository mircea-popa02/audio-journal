const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const WHISPER_URL = 'http://whisper:8000/v1/audio/transcriptions';
const MEMOS_URL = 'http://memos:5230/api/v1/memo';
const MEMOS_TOKEN = 'memos_pat_Af3l9tZLEDrpulkYt1c9HpuzPlSADKU3';

app.post('/webhook/audio', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided.' });
    }

    res.status(202).json({ message: 'Audio accepted for background processing.' });

    processAudio(req.file.buffer, req.file.originalname).catch(console.error);
});

async function processAudio(fileBuffer, filename) {
    try {
        const formData = new FormData();
        const blob = new Blob([fileBuffer], { type: 'audio/mpeg' }); 
        formData.append('file', blob, filename);
        formData.append('model', 'systran/faster-whisper-small');

        console.log('Sending to Whisper...');
        const whisperRes = await fetch(WHISPER_URL, {
            method: 'POST',
            body: formData
        });

        if (!whisperRes.ok) throw new Error(`Whisper failed: ${whisperRes.status}`);
        const whisperData = await whisperRes.json();
        const text = whisperData.text || '';

        const memoContent = `# Audio Journal Log\n\n${text.trim()}`;
        console.log('Pushing to Memos...');

        const memosRes = await fetch(MEMOS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MEMOS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: memoContent })
        });

        if (!memosRes.ok) throw new Error(`Memos upload failed: ${memosRes.status}`);
        console.log('Successfully saved audio journal entry.');

    } catch (error) {
        console.error('Background processing error:', error);
    }
}

app.listen(3000, () => console.log('Audio Webhook Service running on port 3000'));