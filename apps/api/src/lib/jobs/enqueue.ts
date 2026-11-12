import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { Conflict } from "../errors.js";
import { isUniqueViolation } from "../prisma-errors.js";
import { startJob } from "./start.js";

// Every route that queues a job comes through here.
//
// A project may have one job pending or running at a time. Migration 0028's
// partial unique index enforces that, not a read before the insert, so two
// clicks arriving together cannot both get through: the second insert fails
// with P2002 and the caller gets 409. TfJob has no unique constraint besides
// its id and that index, so a P2002 on this insert can only mean the index.

export const JOB_ALREADY_RUNNING = "a job is already running for this project";

/** Inserts a job row, or Conflict while the project has one going. Takes a
 *  transaction client so a caller that changes the project in the same step
 *  can roll that change back when the job is refused. Does not start the job:
 *  call startJob() after the transaction commits, or the runner cannot see
 *  the row yet. */
export async function insertJob(data: Prisma.TfJobUncheckedCreateInput, db: Prisma.TransactionClient = prisma) {
  try {
    return await db.tfJob.create({ data });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Conflict(JOB_ALREADY_RUNNING);
    throw err;
  }
}

/** Inserts a job and starts it. */
export async function enqueueJob(data: Prisma.TfJobUncheckedCreateInput) {
  const job = await insertJob(data);
  startJob(job.id);
  return job;
}
