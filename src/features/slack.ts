import type { SlackConfig, ReviewVerdict, PRState, StructuredReview } from "../types.js";
import type { Logger } from "../logger.js";

export interface SlackNotification {
  pr: string; // "owner/repo#number"
  title: string;
  verdict?: ReviewVerdict;
  summary?: string;
  error?: string;
  url: string;
}

/**
 * Send a Slack notification via webhook.
 */
export async function sendSlackNotification(
  config: SlackConfig,
  notification: SlackNotification,
  logger: Logger,
): Promise<void> {
  if (!config.enabled || !config.webhookUrl) return;

  const emoji = getVerdictEmoji(notification.verdict);
  const color = getVerdictColor(notification.verdict, !!notification.error);

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} Code Review: ${notification.pr}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*PR:*\n<${notification.url}|${notification.title}>`,
        },
        {
          type: "mrkdwn",
          text: `*Verdict:*\n${notification.verdict ?? "Error"}`,
        },
      ],
    },
  ];

  if (notification.summary) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Summary:*\n${notification.summary.slice(0, 500)}`,
      },
    });
  }

  if (notification.error) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Error:*\n\`\`\`${notification.error.slice(0, 300)}\`\`\``,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "View PR",
          emoji: true,
        },
        url: notification.url,
      },
    ],
  });

  const payload = {
    channel: config.channel,
    attachments: [
      {
        color,
        blocks,
      },
    ],
  };

  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn("Slack notification failed", { status: response.status, response: text });
    } else {
      logger.info("Slack notification sent", { pr: notification.pr, verdict: notification.verdict });
    }
  } catch (err) {
    logger.warn("Slack notification error", { error: String(err) });
  }
}

function getVerdictEmoji(verdict?: ReviewVerdict): string {
  switch (verdict) {
    case "APPROVE": return "✅";
    case "REQUEST_CHANGES": return "🔴";
    case "COMMENT": return "💬";
    default: return "⚠️";
  }
}

function getVerdictColor(verdict?: ReviewVerdict, isError?: boolean): string {
  if (isError) return "#ff0000";
  switch (verdict) {
    case "APPROVE": return "#36a64f";
    case "REQUEST_CHANGES": return "#ff9800";
    case "COMMENT": return "#2196f3";
    default: return "#808080";
  }
}

/**
 * Check if we should send a notification for this event.
 */
export function shouldNotify(
  config: SlackConfig,
  event: "review_complete" | "error" | "request_changes" | "approve",
): boolean {
  if (!config.enabled) return false;
  return config.notifyOn.includes(event);
}

/**
 * Build notification from review result.
 */
export function buildReviewNotification(
  state: PRState,
  review: StructuredReview | undefined,
  verdict: ReviewVerdict,
): SlackNotification {
  const pr = `${state.owner}/${state.repo}#${state.number}`;
  const url = `https://github.com/${state.owner}/${state.repo}/pull/${state.number}`;

  return {
    pr,
    title: state.title,
    verdict,
    summary: review?.summary ?? review?.prSummary?.tldr,
    url,
  };
}

/**
 * Build notification from error.
 */
export function buildErrorNotification(
  state: PRState,
  error: string,
): SlackNotification {
  const pr = `${state.owner}/${state.repo}#${state.number}`;
  const url = `https://github.com/${state.owner}/${state.repo}/pull/${state.number}`;

  return {
    pr,
    title: state.title,
    error,
    url,
  };
}
