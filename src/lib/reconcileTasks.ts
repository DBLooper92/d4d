import { getAdminApp } from "@/lib/firebaseAdmin";

export type ReconcileTaskEnqueueResult = {
  queued: boolean;
  deduped: boolean;
  taskName: string;
};

function resolveProjectId(): string {
  const envCandidates = [
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GCP_PROJECT",
    "FIREBASE_ADMIN_PROJECT_ID",
    "FIREBASE_PROJECT_ID",
  ];
  for (const name of envCandidates) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  const appProjectId = getAdminApp().options.projectId;
  return appProjectId ? String(appProjectId) : "";
}

function resolveTasksLocation(): string {
  const envCandidates = ["CLOUD_TASKS_LOCATION", "GOOGLE_CLOUD_REGION", "FUNCTION_REGION", "GCP_REGION"];
  for (const name of envCandidates) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return "us-central1";
}

function resolveTasksQueue(): string {
  const value = process.env.CLOUD_TASKS_QUEUE;
  return value && value.trim().length > 0 ? value.trim() : "ghl-reconcile";
}

function resolveContactDeleteQueue(): string {
  const value = process.env.CLOUD_TASKS_CONTACT_DELETE_QUEUE;
  return value && value.trim().length > 0 ? value.trim() : "ghl-contact-delete";
}

function toTaskId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9-_]/g, "-");
  return cleaned.length > 400 ? cleaned.slice(0, 400) : cleaned;
}

async function fetchServiceAccountToken(): Promise<string | null> {
  try {
    const resp = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("[reconcile] cloud tasks token fetch failed", resp.status, text);
      return null;
    }
    const payload = (await resp.json()) as { access_token?: string };
    return payload.access_token ?? null;
  } catch (err) {
    console.warn("[reconcile] cloud tasks token fetch error", String(err));
    return null;
  }
}

export function resolveTaskBaseUrlFromEnv(): string {
  const fromEnv =
    process.env.GHL_TASK_BASE_URL ||
    process.env.GHL_WEBHOOK_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_BASE_URL;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim().replace(/\/+$/, "") : "";
}

export function resolveTaskBaseUrlFromRequest(req: Request): string {
  const fromEnv = resolveTaskBaseUrlFromEnv();
  if (fromEnv) return fromEnv;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  if (!host) return "";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

export async function enqueueReconcileTask(params: {
  locationId: string;
  groupId: string;
  baseUrl: string;
  attempt?: number;
  delaySeconds?: number;
}): Promise<ReconcileTaskEnqueueResult> {
  const projectId = resolveProjectId();
  const location = resolveTasksLocation();
  const queue = resolveTasksQueue();
  if (!projectId || !location || !queue) {
    console.warn("[reconcile] cloud tasks not configured", { projectId, location, queue });
    return { queued: false, deduped: false, taskName: "" };
  }
  if (!params.baseUrl) {
    console.warn("[reconcile] cloud tasks base url missing");
    return { queued: false, deduped: false, taskName: "" };
  }

  const accessToken = await fetchServiceAccountToken();
  if (!accessToken) return { queued: false, deduped: false, taskName: "" };

  const attempt =
    typeof params.attempt === "number" && Number.isFinite(params.attempt)
      ? Math.max(0, Math.floor(params.attempt))
      : 0;
  const suffix = attempt > 0 ? `-a${attempt}` : "";
  const taskId = toTaskId(`reconcile-${params.locationId}-${params.groupId}${suffix}`);
  const queuePath = `projects/${projectId}/locations/${location}/queues/${queue}`;
  const url = `https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`;
  const reconcileToken = process.env.GHL_RECONCILE_TOKEN;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (reconcileToken && reconcileToken.trim()) {
    headers["x-reconcile-token"] = reconcileToken.trim();
  }

  const delaySeconds = typeof params.delaySeconds === "number" && params.delaySeconds > 0 ? params.delaySeconds : 120;
  const scheduleTime = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const taskName = `${queuePath}/tasks/${taskId}`;
  const task = {
    name: taskName,
    scheduleTime,
    httpRequest: {
      httpMethod: "POST",
      url: `${params.baseUrl.replace(/\/+$/, "")}/api/ghl/reconcile`,
      headers,
      body: Buffer.from(
        JSON.stringify({
          locationId: params.locationId,
          groupId: params.groupId,
          attempt,
        }),
      ).toString("base64"),
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ task }),
  });

  if (resp.status === 409) {
    return { queued: false, deduped: true, taskName };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.warn("[reconcile] cloud tasks enqueue failed", resp.status, text);
    return { queued: false, deduped: false, taskName };
  }
  return { queued: true, deduped: false, taskName };
}

export async function enqueueContactDeleteTask(params: {
  locationId: string;
  contactId: string;
  baseUrl: string;
  webhookId?: string | null;
  contactIdSource?: string | null;
  eventKey?: string | null;
  delaySeconds?: number;
}): Promise<ReconcileTaskEnqueueResult> {
  const projectId = resolveProjectId();
  const location = resolveTasksLocation();
  const queue = resolveContactDeleteQueue();
  if (!projectId || !location || !queue) {
    console.warn("[contact-delete] cloud tasks not configured", { projectId, location, queue });
    return { queued: false, deduped: false, taskName: "" };
  }
  if (!params.baseUrl) {
    console.warn("[contact-delete] cloud tasks base url missing");
    return { queued: false, deduped: false, taskName: "" };
  }

  const accessToken = await fetchServiceAccountToken();
  if (!accessToken) return { queued: false, deduped: false, taskName: "" };

  const webhookId = params.webhookId && params.webhookId.trim().length > 0 ? params.webhookId.trim() : "noid";
  const taskId = toTaskId(`contact-delete-${params.locationId}-${params.contactId}-${webhookId}`);
  const queuePath = `projects/${projectId}/locations/${location}/queues/${queue}`;
  const url = `https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`;
  const reconcileToken = process.env.GHL_RECONCILE_TOKEN;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (reconcileToken && reconcileToken.trim()) {
    headers["x-reconcile-token"] = reconcileToken.trim();
  }

  const delaySeconds = typeof params.delaySeconds === "number" && params.delaySeconds >= 0 ? params.delaySeconds : 1;
  const scheduleTime = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const taskName = `${queuePath}/tasks/${taskId}`;
  const task = {
    name: taskName,
    scheduleTime,
    httpRequest: {
      httpMethod: "POST",
      url: `${params.baseUrl.replace(/\/+$/, "")}/api/ghl/contact-delete`,
      headers,
      body: Buffer.from(
        JSON.stringify({
          locationId: params.locationId,
          contactId: params.contactId,
          webhookId: params.webhookId ?? null,
          contactIdSource: params.contactIdSource ?? null,
          eventKey: params.eventKey ?? null,
          baseUrl: params.baseUrl,
        }),
      ).toString("base64"),
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ task }),
  });

  if (resp.status === 409) {
    return { queued: false, deduped: true, taskName };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.warn("[contact-delete] cloud tasks enqueue failed", resp.status, text);
    return { queued: false, deduped: false, taskName };
  }
  return { queued: true, deduped: false, taskName };
}
