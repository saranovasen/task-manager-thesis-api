import { verifyAccessToken } from '../lib/jwt.js';
import { TokenBlacklistModel } from '../models/TokenBlacklist.js';

export const authRequired = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = verifyAccessToken(token);

    const blacklisted = await TokenBlacklistModel.exists({ token });
    if (blacklisted) {
      return res.status(401).json({ error: 'Token is invalidated' });
    }

    req.user = {
      id: payload.sub,
      email: payload.email,
    };
    req.token = token;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};
