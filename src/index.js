import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectMongo } from './lib/mongo.js';
import authRoutes from './routes/auth.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import tasksRoutes from './routes/tasks.routes.js';
import aiRoutes from './routes/ai.routes.js';
import { notFoundHandler } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(
  cors({
    origin: frontendOrigin,
    credentials: true,
  })
);
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'task-manager-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api', tasksRoutes);
app.use('/api/ai', aiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const start = async () => {
  await connectMongo();

  app.listen(port, () => {
    console.log(`API is running on http://localhost:${port}`);
  });
};

start().catch((error) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
