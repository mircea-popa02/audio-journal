require('dotenv').config();
const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const WHISPER_URL = process.env.WHISPER_URL || 'http://homelab-hp:8000/v1/audio/transcriptions';
const MEMOS_API_URL = process.env.MEMOS_API_URL || 'http://memos:5230/api/v1/memos';
const MEMOS_TOKEN = process.env.MEMOS_TOKEN || 'memos_pat_Af3l9tZLEDrpulkYt1c9HpuzPlSADKU3';

const MEMOS_BASE_API = MEMOS_API_URL.replace(/\/memos\/?$/, '');

app.post('/webhook/audio', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided.' });
    }

    // Extract optional location from iOS Shortcut text fields
    const lat = req.body.lat ? parseFloat(req.body.lat) : null;
    const lon = req.body.lon ? parseFloat(req.body.lon) : null;
    const location = (lat && lon) ? { placeholder: "Audio Location", latitude: lat, longitude: lon } : undefined;

    res.status(202).json({ message: 'Audio accepted. Processing in background.' });
    
    processAudio(req.file.buffer, req.file.originalname, req.file.mimetype, location).catch(console.error);
});

async function processAudio(fileBuffer, filename, mimetype, location) {
    try {
        const requestHeaders = { 'Authorization': `Bearer ${MEMOS_TOKEN}` };

        const formData = new FormData();
        const blob = new Blob([fileBuffer], { type: mimetype || 'audio/mpeg' }); 
        formData.append('file', blob, filename);
        formData.append('model', 'systran/faster-whisper-small');

        console.log('Transcribing audio...');
        const whisperRes = await fetch(WHISPER_URL, { method: 'POST', body: formData });

        if (!whisperRes.ok) throw new Error(`Whisper failed: ${whisperRes.status}`);
        const whisperData = await whisperRes.json();
        const transcription = whisperData.text ? whisperData.text.trim() : '';
        
        if (!transcription) {
            console.log('Transcription empty, skipping memo update.');
            return;
        }

        const now = new Date();
        const logicalDate = new Date(now.getTime() - (3 * 60 * 60 * 1000)); // 3 AM Cutoff
        
        const days = ['Duminică', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'];
        const months = ['Ianuarie', 'Februarie', 'Martie', 'Aprilie', 'Mai', 'Iunie', 'Iulie', 'August', 'Septembrie', 'Octombrie', 'Noiembrie', 'Decembrie'];
        
        const titleDateStr = `${days[logicalDate.getDay()]} ${logicalDate.getDate()} ${months[logicalDate.getMonth()]} ${logicalDate.getFullYear()}`;
        
        const targetTitle = `# ${titleDateStr}`;
        const targetHeader = `#jurnal\n${targetTitle}`;

        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const newEntry = `### [${hh}:${min}]\n${transcription}`;

        let attachmentMeta = null;
        try {
            console.log('Uploading audio attachment to Memos...');
            
            const base64Content = fileBuffer.toString('base64');
            
            const uploadRes = await fetch(`${MEMOS_BASE_API}/attachments`, {
                method: 'POST',
                headers: {
                    ...requestHeaders,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    filename: filename,
                    type: mimetype || 'audio/mpeg',
                    content: base64Content
                })
            });
            
            if (!uploadRes.ok) {
                const errText = await uploadRes.text();
                throw new Error(`${uploadRes.status} ${errText}`);
            }
            
            const resourceData = await uploadRes.json();
            
            attachmentMeta = { name: resourceData.name };
            console.log(`Audio uploaded successfully: ${resourceData.name}`);
            
        } catch (uploadErr) {
            console.error('ERROR: Attachment upload failed. The text will still be saved.', uploadErr);
        }

        console.log(`Checking for existing memo: ${targetTitle}`);
        const listRes = await fetch(`${MEMOS_API_URL}?pageSize=20`, { headers: requestHeaders });
        if (!listRes.ok) throw new Error(`Memos list failed: ${listRes.status}`);
        
        const listData = await listRes.json();
        const existingMemo = (listData.memos || []).find(m => m.content && m.content.includes(targetTitle));

        let finalContent;
        let finalAttachments = [];
        let finalLocation = location;
        let method = 'POST';
        let targetUrl = MEMOS_API_URL;
        let updateMask = [];

        if (existingMemo) {
            finalContent = `${existingMemo.content}\n\n${newEntry}`;
            
            finalAttachments = (existingMemo.attachments || []).map(a => ({ name: a.name }));
            if (attachmentMeta) finalAttachments.push(attachmentMeta);
            
            if (!finalLocation && existingMemo.location) {
                finalLocation = existingMemo.location;
            }

            method = 'PATCH';
            targetUrl = `${MEMOS_BASE_API}/${existingMemo.name}`;
            
            updateMask = ['content', 'attachments'];
            if (finalLocation) updateMask.push('location');
            targetUrl += `?updateMask=${updateMask.join(',')}`;
            
            console.log(`Appending to existing memo: ${existingMemo.name}`);
        } else {
            finalContent = `${targetHeader}\n\n${newEntry}`;
            if (attachmentMeta) finalAttachments.push(attachmentMeta);
            console.log('Creating new daily memo...');
        }

        const payload = { 
            content: finalContent,
            attachments: finalAttachments 
        };
        if (finalLocation) payload.location = finalLocation;

        const upsertRes = await fetch(targetUrl, {
            method: method,
            headers: { ...requestHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
            
        if (!upsertRes.ok) throw new Error(`Memos ${method} failed: ${upsertRes.status} ${await upsertRes.text()}`);
        console.log('Successfully updated Memos.');

    } catch (error) {
        console.error('Pipeline error:', error);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`audio-journal service listening on port ${PORT}`));