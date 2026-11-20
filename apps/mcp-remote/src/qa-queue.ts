import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * The one piece of background work this server needs to hand off.
 *
 * A term is not self-contained. Writing one changes what every existing translation in the project
 * is supposed to say, so the write has to leave a recheck behind it or the termbase is a document
 * again. That recomputation belongs to the worker — it is the same QA run the API queues — and not
 * to the request: an MCP call has a client's timeout attached to it, and scanning a project inside
 * one is how a tool starts failing on the projects big enough to need it.
 *
 * Kept lazy and failure-tolerant on purpose. The queue is created on first use rather than at
 * import (a server that cannot reach Redis should still serve reads), and an enqueue that fails
 * reports `queued: false` instead of throwing: the term **is** written by then, and turning a saved
 * term into an error would be a lie about what happened.
 */

const QUEUE_NAME = 'qa';

let connection: IORedis | null = null;
let queue: Queue | null = null;

function producer(): Queue {
  if (!queue) {
    connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379', { maxRetriesPerRequest: null });
    connection.on('error', () => {
      /* reported by the enqueue that fails, not by an unhandled 'error' event that would kill us */
    });
    queue = new Queue(QUEUE_NAME, { connection });
  }
  return queue;
}

export interface QaRecheckPayload {
  organizationId: string;
  projectId: string;
  requestedBy?: string;
  reason: string;
  terms: string[];
}

/**
 * Ask the worker to re-run QA for a project.
 *
 * One job id per project, with `removeOnComplete`, so an import followed by a correction collapses
 * into a single run instead of two whole-project passes — and the id is free again immediately
 * afterwards, which a completed job kept around would not be.
 */
export async function enqueueQaRecheck(payload: QaRecheckPayload): Promise<{ queued: boolean }> {
  try {
    await producer().add('qa.run', payload, {
      jobId: `qa-glossary-${payload.projectId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    return { queued: true };
  } catch (error) {
    console.error('[mcp-remote] could not queue the glossary recheck:', error instanceof Error ? error.message : error);
    return { queued: false };
  }
}
