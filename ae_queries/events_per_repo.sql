-- Webhook events per repo (last 30 days)
SELECT
  index1 AS repo,
  COUNT() AS event_count
FROM bonk_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 = 'webhook'
GROUP BY repo
ORDER BY event_count DESC
LIMIT 100
