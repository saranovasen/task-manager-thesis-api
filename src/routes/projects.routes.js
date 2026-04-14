import express from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { nextId } from '../lib/ids.js';
import { ProjectModel } from '../models/Project.js';
import { TaskModel } from '../models/Task.js';

const router = express.Router();

const projectCreateSchema = z.object({
  title: z.string().min(1),
  dueDate: z.string().optional(),
  link: z.string().optional(),
});

const projectUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  dueDate: z.string().optional(),
  link: z.string().optional(),
});

router.use(authRequired);

const mapProjectForClient = (project) => {
  const tasksCount = project.tasksCount ?? 0;
  const doneCount = project.doneCount ?? 0;
  // progress = -1 означает, что нет задач (нельзя вычислить прогресс)
  // progress = 0-100 — обычный прогресс
  const progress = tasksCount > 0 ? Math.round((doneCount / tasksCount) * 100) : -1;

  return {
    id: project.id,
    title: project.title,
    link: project.link ?? '—',
    dueDate: project.dueDate ?? 'Без дедлайна',
    tasks: tasksCount,
    progress,
    progressColor: '#2EA3E6',
  };
};

router.get('/', async (req, res) => {
  // Используем aggregation для получения проектов и их статистики в одном запросе
  const projects = await ProjectModel.aggregate([
    { $match: { ownerId: req.user.id } },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: 'tasks',
        let: { projectId: '$id', ownerId: '$ownerId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$projectId', '$$projectId'] }, { $eq: ['$ownerId', '$$ownerId'] }],
              },
            },
          },
          {
            $group: {
              _id: null,
              tasksCount: { $sum: 1 },
              doneCount: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'done'] }, 1, 0],
                },
              },
            },
          },
        ],
        as: 'taskStats',
      },
    },
    {
      $project: {
        id: 1,
        title: 1,
        link: 1,
        dueDate: 1,
        ownerId: 1,
        tasksCount: { $ifNull: [{ $arrayElemAt: ['$taskStats.tasksCount', 0] }, 0] },
        doneCount: { $ifNull: [{ $arrayElemAt: ['$taskStats.doneCount', 0] }, 0] },
      },
    },
  ]);

  const normalized = projects.map(mapProjectForClient);
  res.json(normalized);
});

router.post('/', validate(projectCreateSchema), async (req, res) => {
  const project = await ProjectModel.create({
    id: nextId('prj'),
    ownerId: req.user.id,
    title: req.body.title,
    dueDate: req.body.dueDate ?? null,
    link: req.body.link ?? null,
  });

  // Новый проект не имеет задач, поэтому progress = -1
  const normalized = mapProjectForClient({
    ...project.toObject(),
    tasksCount: 0,
    doneCount: 0,
  });
  res.status(201).json(normalized);
});

router.patch('/:projectId', validate(projectUpdateSchema), async (req, res) => {
  const project = await ProjectModel.findOne({ id: req.params.projectId, ownerId: req.user.id });

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (req.body.title !== undefined) project.title = req.body.title;
  if (req.body.dueDate !== undefined) project.dueDate = req.body.dueDate;
  if (req.body.link !== undefined) project.link = req.body.link;

  await project.save();

  // Получим счётчики задач для обновленного проекта
  const tasksCount = await TaskModel.countDocuments({ projectId: project.id, ownerId: project.ownerId });
  const doneCount = await TaskModel.countDocuments({ projectId: project.id, ownerId: project.ownerId, status: 'done' });

  const normalized = mapProjectForClient({
    ...project.toObject(),
    tasksCount,
    doneCount,
  });
  return res.json(normalized);
});

router.delete('/:projectId', async (req, res) => {
  const project = await ProjectModel.findOneAndDelete({ id: req.params.projectId, ownerId: req.user.id });

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  await TaskModel.deleteMany({ projectId: project.id, ownerId: req.user.id });

  return res.json({ ok: true });
});

export default router;
