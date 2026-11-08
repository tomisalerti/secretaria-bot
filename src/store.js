// Persistencia simple en archivos JSON/MD dentro de DATA_DIR (volumen de Railway).
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const p = (name) => path.join(DATA_DIR, name);

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, data) {
  const tmp = p(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p(name));
}

// ---- Historial de conversación (solo texto, últimos N turnos) ----
const HISTORY_FILE = 'history.json';
const MAX_TURNS = 30;

export function getHistory() {
  return readJson(HISTORY_FILE, []);
}

export function appendHistory(role, text) {
  const h = getHistory();
  h.push({ role, content: text, at: new Date().toISOString() });
  writeJson(HISTORY_FILE, h.slice(-MAX_TURNS));
}

// ---- Notas persistentes de la secretaria ----
const NOTES_FILE = 'notas.md';

export function getNotes() {
  try {
    return fs.readFileSync(p(NOTES_FILE), 'utf8');
  } catch {
    return '';
  }
}

export function addNote(text) {
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${text.trim()}\n`;
  fs.appendFileSync(p(NOTES_FILE), line);
  // Evita que el archivo crezca sin límite: conserva las últimas 300 líneas.
  const lines = getNotes().split('\n').filter(Boolean);
  if (lines.length > 300) {
    fs.writeFileSync(p(NOTES_FILE), lines.slice(-300).join('\n') + '\n');
  }
}

export function dataPath(name) {
  return p(name);
}
