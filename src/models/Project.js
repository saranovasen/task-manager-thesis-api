import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    ownerId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    dueDate: { type: String, default: null },
    link: { type: String, default: null },
  },
  { timestamps: true }
);

export const ProjectModel = mongoose.model('Project', projectSchema);
