import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../../data/db.json');

const defaultDb = {
  users: [],
  projects: [],
  tasks: [],
  tokenBlacklist: [],
};

const ensureDbFile = () => {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2), 'utf-8');
  }
};

export const readDb = () => {
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2), 'utf-8');
    return structuredClone(defaultDb);
  }
};

export const writeDb = (db) => {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
};

export const nextId = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
