import express from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { nextId } from '../lib/ids.js';
import { ProjectModel } from '../models/Project.js';
import { TaskModel } from '../models/Task.js';

const router = express.Router();

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['queue', 'in-progress', 'review', 'done']).default('queue'),
  dueDate: z.string().optional(),
  category: z.string().optional(),
  categoryColor: z.string().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['queue', 'in-progress', 'review', 'done']).optional(),
  dueDate: z.string().optional(),
  category: z.string().optional(),
  categoryColor: z.string().optional(),
});

const createSubtaskSchema = z.object({
  title: z.string().min(1),
});

const updateSubtaskSchema = z
  .object({
    isDone: z.boolean().optional(),
    title: z.string().min(1).optional(),
  })
  .refine((value) => value.isDone !== undefined || value.title !== undefined, {
    message: 'At least one field is required',
  });

router.use(authRequired);

const mapTaskForClient = (task) => ({
  id: task.id,
  projectId: task.projectId,
  title: task.title,
  status: task.status,
  category: task.category ?? 'General',
  categoryColor: task.categoryColor ?? '#5051F9',
  description: task.description ?? '',
  dateLabel: task.dateLabel ?? 'Срок не указан',
  subtasks: Array.isArray(task.subtasks)
    ? task.subtasks.map((subtask) => ({
        id: subtask.id,
        title: subtask.title,
        isDone: Boolean(subtask.isDone),
      }))
    : [],
});

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const MS_IN_WEEK = 7 * MS_IN_DAY;
const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTH_LABELS = [
  'Янв',
  'Фев',
  'Мар',
  'Апр',
  'Май',
  'Июн',
  'Июл',
  'Авг',
  'Сен',
  'Окт',
  'Ноя',
  'Дек',
];

const utcDayStart = (date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
const addUtcDays = (date, days) => new Date(date.getTime() + days * MS_IN_DAY);
const formatDayKey = (date) => date.toISOString().slice(0, 10);
const formatMonthKey = (date) => date.toISOString().slice(0, 7);

const aggregateCreatedByDay = (ownerId, start, endExclusive) => {
  return TaskModel.aggregate([
    { $match: { ownerId, createdAt: { $gte: start, $lt: endExclusive } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$createdAt',
            timezone: 'UTC',
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);
};

const aggregateCompletedByDay = (ownerId, start, endExclusive) => {
  return TaskModel.aggregate([
    {
      $match: {
        ownerId,
        $or: [{ completedAt: { $ne: null } }, { status: 'done' }],
      },
    },
    {
      $project: {
        effectiveCompletedAt: { $ifNull: ['$completedAt', '$updatedAt'] },
      },
    },
    {
      $match: {
        effectiveCompletedAt: { $gte: start, $lt: endExclusive },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$effectiveCompletedAt',
            timezone: 'UTC',
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);
};

const aggregateCreatedByWeekIndex = (
  ownerId,
  start,
  endExclusive,
  weeksCount,
) => {
  return TaskModel.aggregate([
    { $match: { ownerId, createdAt: { $gte: start, $lt: endExclusive } } },
    {
      $project: {
        weekIndex: {
          $floor: {
            $divide: [{ $subtract: ['$createdAt', start] }, MS_IN_WEEK],
          },
        },
      },
    },
    { $match: { weekIndex: { $gte: 0, $lt: weeksCount } } },
    {
      $group: {
        _id: '$weekIndex',
        count: { $sum: 1 },
      },
    },
  ]);
};

const aggregateCompletedByWeekIndex = (
  ownerId,
  start,
  endExclusive,
  weeksCount,
) => {
  return TaskModel.aggregate([
    {
      $match: {
        ownerId,
        $or: [{ completedAt: { $ne: null } }, { status: 'done' }],
      },
    },
    {
      $project: {
        effectiveCompletedAt: { $ifNull: ['$completedAt', '$updatedAt'] },
      },
    },
    {
      $match: {
        effectiveCompletedAt: { $gte: start, $lt: endExclusive },
      },
    },
    {
      $project: {
        weekIndex: {
          $floor: {
            $divide: [
              { $subtract: ['$effectiveCompletedAt', start] },
              MS_IN_WEEK,
            ],
          },
        },
      },
    },
    { $match: { weekIndex: { $gte: 0, $lt: weeksCount } } },
    {
      $group: {
        _id: '$weekIndex',
        count: { $sum: 1 },
      },
    },
  ]);
};

const aggregateCreatedByMonthKey = (ownerId, start, endExclusive) => {
  return TaskModel.aggregate([
    { $match: { ownerId, createdAt: { $gte: start, $lt: endExclusive } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m',
            date: '$createdAt',
            timezone: 'UTC',
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);
};

const aggregateCompletedByMonthKey = (ownerId, start, endExclusive) => {
  return TaskModel.aggregate([
    {
      $match: {
        ownerId,
        $or: [{ completedAt: { $ne: null } }, { status: 'done' }],
      },
    },
    {
      $project: {
        effectiveCompletedAt: { $ifNull: ['$completedAt', '$updatedAt'] },
      },
    },
    {
      $match: {
        effectiveCompletedAt: { $gte: start, $lt: endExclusive },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m',
            date: '$effectiveCompletedAt',
            timezone: 'UTC',
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);
};

router.get('/projects/:projectId/tasks', async (req, res) => {
  const project = await ProjectModel.findOne({
    id: req.params.projectId,
    ownerId: req.user.id,
  }).lean();
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const tasks = await TaskModel.find({
    projectId: project.id,
    ownerId: req.user.id,
  })
    .sort({ createdAt: -1 })
    .lean();
  return res.json(tasks.map(mapTaskForClient));
});

router.post(
  '/projects/:projectId/tasks',
  validate(createTaskSchema),
  async (req, res) => {
    const project = await ProjectModel.findOne({
      id: req.params.projectId,
      ownerId: req.user.id,
    }).lean();
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const task = await TaskModel.create({
      id: nextId('tsk'),
      projectId: project.id,
      ownerId: req.user.id,
      title: req.body.title,
      description: req.body.description ?? '',
      status: req.body.status,
      completedAt: req.body.status === 'done' ? new Date() : null,
      dateLabel: req.body.dueDate ?? 'Срок не указан',
      category: req.body.category ?? 'General',
      categoryColor: req.body.categoryColor ?? '#5051F9',
      subtasks: [],
    });

    return res.status(201).json(mapTaskForClient(task.toObject()));
  },
);

router.post(
  '/tasks/:taskId/subtasks',
  validate(createSubtaskSchema),
  async (req, res) => {
    const task = await TaskModel.findOne({
      id: req.params.taskId,
      ownerId: req.user.id,
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (!Array.isArray(task.subtasks)) {
      task.subtasks = [];
    }

    task.subtasks.push({
      id: nextId('sub'),
      title: req.body.title,
      isDone: false,
    });

    await task.save();
    return res.status(201).json(mapTaskForClient(task.toObject()));
  },
);

router.patch(
  '/tasks/:taskId/subtasks/:subtaskId',
  validate(updateSubtaskSchema),
  async (req, res) => {
    const task = await TaskModel.findOne({
      id: req.params.taskId,
      ownerId: req.user.id,
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const subtask = task.subtasks?.find(
      (item) => item.id === req.params.subtaskId,
    );
    if (!subtask) {
      return res.status(404).json({ error: 'Subtask not found' });
    }

    if (req.body.isDone !== undefined) {
      subtask.isDone = req.body.isDone;
    }

    if (req.body.title !== undefined) {
      subtask.title = req.body.title;
    }

    await task.save();
    return res.json(mapTaskForClient(task.toObject()));
  },
);

router.delete('/tasks/:taskId/subtasks/:subtaskId', async (req, res) => {
  const task = await TaskModel.findOne({
    id: req.params.taskId,
    ownerId: req.user.id,
  });

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const initialLength = Array.isArray(task.subtasks) ? task.subtasks.length : 0;
  task.subtasks = (task.subtasks ?? []).filter(
    (item) => item.id !== req.params.subtaskId,
  );

  if (task.subtasks.length === initialLength) {
    return res.status(404).json({ error: 'Subtask not found' });
  }

  await task.save();
  return res.json(mapTaskForClient(task.toObject()));
});

router.patch('/tasks/:taskId', validate(updateTaskSchema), async (req, res) => {
  const task = await TaskModel.findOne({
    id: req.params.taskId,
    ownerId: req.user.id,
  });

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (req.body.title !== undefined) task.title = req.body.title;
  if (req.body.description !== undefined)
    task.description = req.body.description;
  if (req.body.status !== undefined) {
    const previousStatus = task.status;
    task.status = req.body.status;

    if (previousStatus !== 'done' && req.body.status === 'done') {
      task.completedAt = new Date();
    }

    if (previousStatus === 'done' && req.body.status !== 'done') {
      task.completedAt = null;
    }
  }
  if (req.body.dueDate !== undefined)
    task.dateLabel = req.body.dueDate || 'Срок не указан';
  if (req.body.category !== undefined) task.category = req.body.category;
  if (req.body.categoryColor !== undefined)
    task.categoryColor = req.body.categoryColor;
  await task.save();

  return res.json(mapTaskForClient(task.toObject()));
});

router.delete('/tasks/:taskId', async (req, res) => {
  const removed = await TaskModel.findOneAndDelete({
    id: req.params.taskId,
    ownerId: req.user.id,
  });

  if (!removed) {
    return res.status(404).json({ error: 'Task not found' });
  }

  return res.json({ ok: true });
});

router.get('/tasks/summary', async (req, res) => {
  const ownerId = req.user.id;
  const todayStart = utcDayStart(new Date());
  const start = addUtcDays(todayStart, -6);
  const end = addUtcDays(todayStart, 1);
  const days = Array.from({ length: 7 }, (_, index) =>
    addUtcDays(start, index),
  );

  const [statusCounts, newRows, completedRows, doneProjectsRows] =
    await Promise.all([
      TaskModel.aggregate([
        { $match: { ownerId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      aggregateCreatedByDay(ownerId, start, end),
      aggregateCompletedByDay(ownerId, start, end),
      TaskModel.aggregate([
        { $match: { ownerId } },
        {
          $group: {
            _id: '$projectId',
            tasksCount: { $sum: 1 },
            doneCount: {
              $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] },
            },
            doneAt: { $max: { $ifNull: ['$completedAt', '$updatedAt'] } },
          },
        },
        {
          $match: {
            $expr: {
              $and: [
                { $gt: ['$tasksCount', 0] },
                { $eq: ['$tasksCount', '$doneCount'] },
              ],
            },
          },
        },
        {
          $project: {
            _id: 1,
            doneAt: 1,
          },
        },
      ]),
    ]);

  const statusMap = new Map(statusCounts.map((row) => [row._id, row.count]));
  const done = statusMap.get('done') ?? 0;
  const newTotalForPeriod = newRows.reduce(
    (sum, row) => sum + (row.count ?? 0),
    0,
  );

  const newByDayKey = new Map(newRows.map((row) => [row._id, row.count]));
  const completedByDayKey = new Map(
    completedRows.map((row) => [row._id, row.count]),
  );

  const doneProjectTimestamps = doneProjectsRows
    .map((row) => new Date(row.doneAt).getTime())
    .filter((timestamp) => Number.isFinite(timestamp));

  const projectsTrend = days.map((day) => {
    const dayEnd = addUtcDays(day, 1).getTime();
    return doneProjectTimestamps.filter((timestamp) => timestamp < dayEnd)
      .length;
  });

  return res.json([
    {
      id: 'completed',
      title: 'Готово',
      amount: done,
      trendData: days.map(
        (day) => completedByDayKey.get(formatDayKey(day)) ?? 0,
      ),
      lineColor: '#5051F9',
    },
    {
      id: 'new',
      title: 'Новое',
      amount: newTotalForPeriod,
      trendData: days.map((day) => newByDayKey.get(formatDayKey(day)) ?? 0),
      lineColor: '#1EA7FF',
    },
    {
      id: 'projects',
      title: 'Готовые проекты',
      amount: doneProjectsRows.length,
      trendData: projectsTrend,
      lineColor: '#FF614C',
    },
  ]);
});

router.get('/tasks/dynamics', async (req, res) => {
  const ownerId = req.user.id;
  const period = String(req.query.period || 'month');
  const todayStart = utcDayStart(new Date());
  const tomorrowStart = addUtcDays(todayStart, 1);

  if (period === 'week') {
    const start = addUtcDays(todayStart, -6);
    const [newRows, completedRows] = await Promise.all([
      aggregateCreatedByDay(ownerId, start, tomorrowStart),
      aggregateCompletedByDay(ownerId, start, tomorrowStart),
    ]);

    const newByDayKey = new Map(newRows.map((row) => [row._id, row.count]));
    const completedByDayKey = new Map(
      completedRows.map((row) => [row._id, row.count]),
    );
    const days = Array.from({ length: 7 }, (_, index) =>
      addUtcDays(start, index),
    );

    return res.json({
      labels: days.map((day) => WEEKDAY_LABELS[day.getUTCDay()]),
      completed: days.map(
        (day) => completedByDayKey.get(formatDayKey(day)) ?? 0,
      ),
      newTasks: days.map((day) => newByDayKey.get(formatDayKey(day)) ?? 0),
    });
  }

  if (period === 'year') {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    const [newRows, completedRows] = await Promise.all([
      aggregateCreatedByMonthKey(ownerId, start, end),
      aggregateCompletedByMonthKey(ownerId, start, end),
    ]);

    const newByMonthKey = new Map(newRows.map((row) => [row._id, row.count]));
    const completedByMonthKey = new Map(
      completedRows.map((row) => [row._id, row.count]),
    );
    const months = Array.from(
      { length: 12 },
      (_, index) =>
        new Date(
          Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1),
        ),
    );

    return res.json({
      labels: months.map((monthDate) => MONTH_LABELS[monthDate.getUTCMonth()]),
      completed: months.map(
        (monthDate) => completedByMonthKey.get(formatMonthKey(monthDate)) ?? 0,
      ),
      newTasks: months.map(
        (monthDate) => newByMonthKey.get(formatMonthKey(monthDate)) ?? 0,
      ),
    });
  }

  const weeksCount = 5;
  const start = addUtcDays(todayStart, -(weeksCount * 7 - 1));
  const [newRows, completedRows] = await Promise.all([
    aggregateCreatedByWeekIndex(ownerId, start, tomorrowStart, weeksCount),
    aggregateCompletedByWeekIndex(ownerId, start, tomorrowStart, weeksCount),
  ]);

  const newByWeekIndex = new Map(newRows.map((row) => [row._id, row.count]));
  const completedByWeekIndex = new Map(
    completedRows.map((row) => [row._id, row.count]),
  );

  return res.json({
    labels: Array.from(
      { length: weeksCount },
      (_, index) => `Нед ${index + 1}`,
    ),
    completed: Array.from(
      { length: weeksCount },
      (_, index) => completedByWeekIndex.get(index) ?? 0,
    ),
    newTasks: Array.from(
      { length: weeksCount },
      (_, index) => newByWeekIndex.get(index) ?? 0,
    ),
  });
});

export default router;
