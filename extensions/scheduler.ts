import type { Job } from '../src/types.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { errorOf } from '../src/errors.ts';
import { Type } from 'typebox';
import { lifecycle } from '../src/host.ts';
import { log } from '../src/log.ts';

export async function runJob(host: Host, chatId: string, job: Job, now = Date.now()) {
  if (job.running || host.closing || host.restarting) return;
  // Keep due jobs on disk until a slot opens, rather than loading many sessions.
  if (host.records.flatMap(chat => chat.jobs).filter(item => item.running).length >= 2) return;
  job.running = true;
  log.info('job.started', { chatId, jobId: job.id });
  try {
    await host.save();
    await host.submit(job.prompt, `Scheduled task: ${job.name}`, chatId);
    job.lastRunAt = new Date(now).toISOString();
    job.nextRunAt = job.everyMinutes ? new Date(Math.max(now, Date.now()) + job.everyMinutes * 60000).toISOString() : null;
    job.enabled = job.everyMinutes > 0;
    job.lastError = '';
    log.info('job.finished', { chatId, jobId: job.id });
  } catch (caught) {
    const error = errorOf(caught); job.lastError = error.message;
    // Keep shutdown interruptions marked for recovery, including manual runs.
    if (!host.closing && !host.restarting) {
      job.enabled = true;
      job.nextRunAt = new Date(Math.max(now, Date.now()) + 60000).toISOString();
      job.running = false;
    }
    log.error('job.failed', { chatId, jobId: job.id, error });
    await host.save();
    return;
  }
  job.running = false;
  await host.save();
}
export function tick(host: Host, now = Date.now()) {
  for (const chat of host.records) for (const job of chat.jobs) {
    if (job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now && !job.running) {
      runJob(host, chat.id, job, now).catch(error => log.error('job.persist_failed', { chatId: chat.id, jobId: job.id, error }));
    }
  }
}

export async function recoverJobs(host: Host, now = Date.now()) {
  for (const chat of host.records) for (const job of chat.jobs) if (job.running) {
    job.running = false;
    job.enabled = true;
    job.nextRunAt = new Date(now).toISOString();
    job.lastError = 'Interrupted by restart. Retrying.';
  }
  await host.save();
  tick(host, now);
}

export default function scheduler(pi: ExtensionAPI, host: Host, _options: ExtensionOptions<'scheduler'>, chatId = 'main') {
  let timer: NodeJS.Timeout | undefined;
  lifecycle(pi, host, 'scheduler', async () => {
    host.runJob = async (id, jobId) => {
      const job = host.record(id).jobs.find(job => job.id === jobId);
      if (!job) throw Object.assign(new Error('Job not found.'), { status: 404 });
      if (job.running) throw Object.assign(new Error('Job is already running.'), { status: 409 });
      job.enabled = true;
      job.nextRunAt = new Date().toISOString();
      await host.save();
      runJob(host, id, job).catch(error => log.error('job.persist_failed', { chatId: id, jobId, error }));
    };
    await recoverJobs(host);
    timer = setInterval(() => tick(host), 1000);
  }, () => { clearInterval(timer); });
  pi.registerTool({
    name: 'schedule', label: 'Schedule a task',
    description: 'Create a scheduled task in this chat. Results return to this conversation while the browser is closed. everyMinutes=0 runs once; otherwise repeat at that interval. nextRunAt is an ISO UTC timestamp. Only create tasks requested by the owner.',
    parameters: Type.Object({ name: Type.String({ maxLength: 100 }), prompt: Type.String({ maxLength: 16000 }),
      everyMinutes: Type.Integer({ minimum: 0, maximum: 525600 }), nextRunAt: Type.Optional(Type.String()) }),
    async execute(_id, input) {
      const job = await host.addJob(chatId, input);
      return { content: [{ type: 'text', text: `Scheduled ${job.name}. Next run: ${job.nextRunAt}. Job ID: ${job.id}` }], details: {} };
    },
  });
}
