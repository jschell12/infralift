# 0006. Jobs are a queue in Postgres, and interrupted jobs are not retried

**Status:** accepted, 2026-11-08

## Decision

A `TfJob` row is the queue entry. One API process claims it with a conditional update before running it. A worker sweeps for pending jobs nobody claimed, and at boot marks jobs left unfinished by a process that is gone as errored ("interrupted"). Interrupted jobs are not retried automatically (`lib/jobs/queue.ts`).

## Why

Jobs used to start with a fire-and-forget call inside the request, so a restart left a running job at "running" forever and a job queued just before a restart never started. A table already existed for jobs, and a conditional update is enough to keep two processes from running one job, so no separate queue service is needed.

Jobs open pull requests, push commits and create workspaces in customers' accounts. Most steps are idempotent, but not all, so a person decides whether to run an interrupted job again.

## Cost

It assumes one API process at a time: recovery treats every claim by another process as abandoned. The Nomad job runs one copy and a deploy restarts it in place, so that holds today. Running two copies needs a heartbeat on claimed jobs first.

A restart during a deploy interrupts whatever job was running, and the customer sees it errored and starts it again. Polling every 15 seconds means a job left pending can wait that long to start.
