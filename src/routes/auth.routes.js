import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authRequired } from '../middleware/auth.js';
import { nextId } from '../lib/ids.js';
import { signAccessToken } from '../lib/jwt.js';
import { UserModel } from '../models/User.js';
import { TokenBlacklistModel } from '../models/TokenBlacklist.js';

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
});

const sanitizeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
});

const ensureSeedUser = async () => {
  const exists = await UserModel.exists({ email: 'demo@demo.ru' });
  if (exists) return;

  const passwordHash = bcrypt.hashSync('123456', 10);
  await UserModel.create({
    id: nextId('usr'),
    name: 'Demo User',
    email: 'demo@demo.ru',
    passwordHash,
  });
};

router.post('/register', validate(registerSchema), async (req, res) => {
  const name = req.body.name.trim();
  const email = req.body.email.toLowerCase().trim();
  const password = req.body.password;

  const exists = await UserModel.exists({ email });
  if (exists) {
    return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await UserModel.create({
    id: nextId('usr'),
    name,
    email,
    passwordHash,
  });

  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  return res.status(201).json({ accessToken, user: sanitizeUser(user) });
});

router.post('/login', validate(loginSchema), async (req, res) => {
  await ensureSeedUser();
  const { email, password } = req.body;
  const user = await UserModel.findOne({ email: email.toLowerCase() }).lean();
  if (!user) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  return res.json({ accessToken, user: sanitizeUser(user) });
});

router.get('/me', authRequired, async (req, res) => {
  const user = await UserModel.findOne({ id: req.user.id }).lean();

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  return res.json(sanitizeUser(user));
});

router.post('/logout', authRequired, async (req, res) => {
  await TokenBlacklistModel.updateOne({ token: req.token }, { token: req.token }, { upsert: true });

  return res.json({ ok: true });
});

export default router;
