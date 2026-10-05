import type { Job } from '../src/types.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { errorOf } from '../src/errors.ts';
import { Type } from 'typebox';
import { lifecycle } from '../src/host.ts';
import { log } from '../src/log.ts';

export async function runJob(host: Host, chatId: string, job: Job, now = Date.now()) {
  if (job.running || host.closing || host.restarting || host.deleting.has(chatId)) return;
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
  for (const chat of host.records.filter(chat => !chat.deleted)) for (const job of chat.jobs) {
    if (job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now && !job.running) {
      runJob(host, chat.id, job, now).catch(error => log.error('job.persist_failed', { chatId: chat.id, jobId: job.id, error }));
    }
  }
}

export async function recoverJobs(host: Host, now = Date.now()) {
  for (const chat of host.records) for (const job of chat.jobs) if (job.running || job.lastError === 'Interrupted by restart. Run again when ready.') {
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
    name: 'schedule', label: 'Scheduled tasks',
    description: 'Manage scheduled tasks in this chat only. action defaults to create (name and prompt required). list returns saved tasks and IDs; use those IDs to update or remove the task the owner means. update changes only supplied fields; enabled=false pauses, enabled=true resumes. Changing everyMinutes resets the next run from now unless nextRunAt is supplied; resuming an overdue task catches up once. Restarting a completed task requires nextRunAt. everyMinutes=0 runs once; otherwise repeat at that interval. nextRunAt is an ISO UTC timestamp. Results return here while the browser is closed. Only change tasks requested by the owner. Do not guess IDs or silently recreate tasks when asked to change or cancel them.',
    parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal('create'), Type.Literal('list'), Type.Literal('update'), Type.Literal('remove')])),
      id: Type.Optional(Type.String({ minLength: 1 })), name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
      everyMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 525600 })), nextRunAt: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()) }),
    async execute(_id, input) {
      const { action = 'create', id, ...fields } = input;
      const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      let result: unknown;
      if (action === 'list') {
        if (id || Object.keys(changes).length) throw Error('List needs no ID or changes.');
        result = host.record(chatId).jobs;
      } else if (action === 'create') {
        if (id || fields.enabled !== undefined) throw Error('Create a task with name, prompt and optional timing fields.');
        result = await host.addJob(chatId, changes);
      } else {
        if (!id) throw Error('List tasks first, then use the saved job ID.');
        if (action === 'update') result = await host.updateJob(chatId, id, changes);
        else {
          if (Object.keys(changes).length) throw Error('Remove needs only the saved job ID.');
          await host.removeJob(chatId, id); result = { removed: id };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  });
}
