/**
 * internal.ts
 *
 * Router HTTP nội bộ phía official bot cho task-proof.
 * Step 1 chỉ có worker-down; các endpoint Section 10 còn lại thêm sau.
 */

import { Router, Request, Response } from 'express';
import { rejectIfInvalidInternalKey } from './internalAuth';
import { notifyAdminWorkerDown } from './notifyAdmin';

export const taskproofInternalRouter = Router();

taskproofInternalRouter.post(
  '/internal/taskproof/worker-down',
  async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;

    const code = typeof req.body?.code === 'number' ? req.body.code : null;
    const signal = typeof req.body?.signal === 'string' ? req.body.signal : null;

    const result = await notifyAdminWorkerDown({ code, signal });
    res.json({ success: true, ...result });
  }
);
