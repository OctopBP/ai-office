import fs from 'node:fs';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import { style } from './common.mjs';

let client = null;
export function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY не задан. Скопируйте tools/props/.env.example → tools/props/.env и вставьте ключ.');
  }
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export function modelId(kind = 'flash') {
  if (kind === 'pro') return process.env.PROPS_MODEL_PRO || style.models.pro;
  return process.env.PROPS_MODEL_FLASH || style.models.flash;
}

function fileToRef(p) {
  const data = fs.readFileSync(p).toString('base64');
  const ext = p.toLowerCase().endsWith('.jpg') || p.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  return { mime: ext, data };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Сгенерировать одну картинку.
 * @returns {Promise<{png: Buffer, model: string, api: string, text?: string}>}
 */
export async function generateImage({ prompt, refPaths = [], model = 'flash', aspect = '1:1', imageSize, seed, retries = 3 }) {
  const ai = getClient();
  const mid = modelId(model);
  const refs = refPaths.map(fileToRef);
  const size = imageSize || style.image_size || '1K';

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 1) Interactions API (@google/genai ≥ 1.30): input = блоки контента, картинка в outputs[]
      if (ai.interactions?.create) {
        const input = [{ type: 'text', text: prompt }, ...refs.map(r => ({ type: 'image', mime_type: r.mime, data: r.data }))];
        const params = {
          model: mid,
          input,
          response_modalities: ['image'],
          response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: aspect, image_size: size },
        };
        if (seed !== undefined) params.generation_config = { seed };
        const it = await ai.interactions.create(params);
        const img = it.output_image ?? findImageInSteps(it);
        if (!img?.data) {
          const text = (it.outputs || []).filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 200);
          throw new Error('В ответе нет изображения (interactions)' + (text ? `: ${text}` : ''));
        }
        return { png: await toPng(Buffer.from(img.data, 'base64')), model: mid, api: 'interactions', text: it.output_text };
      }
      // 2) Фолбэк: generateContent
      const contents = [{ role: 'user', parts: [{ text: prompt }, ...refs.map(r => ({ inlineData: { mimeType: r.mime, data: r.data } }))] }];
      const res = await ai.models.generateContent({
        model: mid,
        contents,
        config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect, imageSize: size } },
      });
      const parts = res.candidates?.[0]?.content?.parts || [];
      const part = parts.find(p => p.inlineData?.data);
      if (!part) throw new Error('В ответе нет изображения (generateContent): ' + (parts.map(p => p.text).filter(Boolean).join(' ') || 'пусто'));
      return { png: await toPng(Buffer.from(part.inlineData.data, 'base64')), model: mid, api: 'generateContent' };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const retriable = /429|RESOURCE_EXHAUSTED|503|500|deadline|ECONNRESET|fetch failed|unusable/i.test(msg);
      if (!retriable || attempt === retries) break;
      const wait = 2000 * 2 ** attempt;
      console.warn(`  ↻ повтор через ${wait / 1000}s: ${msg.slice(0, 120)}`);
      client = null; // после ошибки транспорта SDK может оставить тело запроса «использованным» — берём свежий клиент
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Модель может отдать JPEG — нормализуем в PNG (без потерь дальше по пайплайну) */
async function toPng(buf) { return sharp(buf).png().toBuffer(); }

function findImageInSteps(it) {
  for (const block of it.outputs || []) if (block.type === 'image' && block.data) return block;
  for (const step of it.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) if (block.type === 'image' && block.data) return block;
  }
  for (const block of it.outputs || []) if (block.type === 'image' && block.data) return block;
  return null;
}
