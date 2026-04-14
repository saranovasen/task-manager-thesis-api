import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    projectId: { type: String, required: true, index: true },
    ownerId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    status: { type: String, enum: ['queue', 'in-progress', 'review', 'done'], default: 'queue' },
    completedAt: { type: Date, default: null },
    dateLabel: { type: String, default: 'Срок не указан' },
    category: { type: String, default: 'General' },
    categoryColor: { type: String, default: '#5051F9' },
    subtasks: [
      {
        _id: false,
        id: { type: String, required: true },
        title: { type: String, required: true },
        isDone: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true }
);

taskSchema.index({ ownerId: 1, createdAt: 1 });
taskSchema.index({ ownerId: 1, completedAt: 1 });
taskSchema.index({ ownerId: 1, status: 1 });
taskSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });

export const TaskModel = mongoose.model('Task', taskSchema);
