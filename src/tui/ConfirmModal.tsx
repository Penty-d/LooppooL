import React from 'react';
import { Text, Box } from 'ink';
import stringWidth from 'string-width';

/**
 * 确认弹窗（计划审批 / 危险命令确认共用）
 *
 * 整屏替换主界面：确认期间 run 被 requestConfirm 阻塞，无任务事件涌入，安全。
 * 复用 TaskDetail/Summary 的 wrapText + slice 滚动技术。
 */
export function ConfirmModal({
  message,
  width,
  height,
  scroll,
  queued,
}: {
  message: string;
  width: number;
  height: number;
  scroll: number;
  queued: number;
}) {
  // 内容区行数：全屏 - 上下边框 - 标题 - 分隔线 - footer
  const contentHeight = Math.max(1, height - 5);

  const lines: React.ReactNode[] = [];
  let lineKey = 0;
  const pushLine = (node: React.ReactNode) => {
    lines.push(<React.Fragment key={lineKey++}>{node}</React.Fragment>);
  };

  pushLine(
    <Box>
      <Text bold color="yellow">✦ 需要确认</Text>
    </Box>
  );
  pushLine(
    <Box>
      <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
    </Box>
  );

  const bodyLines = wrapText(message, Math.max(10, width - 2));
  for (const ln of bodyLines) {
    pushLine(
      <Box paddingLeft={1}>
        <Text>{ln}</Text>
      </Box>
    );
  }

  // 滚动裁剪
  const start = Math.max(
    0,
    Math.min(scroll, Math.max(0, lines.length - contentHeight))
  );
  const visible = lines.slice(start, start + contentHeight);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      paddingX={1}
    >
      {visible}
      {/* flexGrow 占位：把 footer 钉到弹窗底部 */}
      <Box flexGrow={1} />
      <Box>
        <Text color="green" bold>Enter 批准</Text>
        <Text dimColor> · </Text>
        <Text color="red" bold>Esc / n / x 拒绝</Text>
        {queued > 1 && (
          <Text dimColor> · 还有 {queued - 1} 条待确认</Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * 按真实列宽把长文本折成多行（CJK/emoji 占 2 列）
 */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    let cur = '';
    let curWidth = 0;
    for (const ch of rawLine) {
      const w = stringWidth(ch);
      if (curWidth + w > width) {
        out.push(cur);
        cur = ch;
        curWidth = w;
      } else {
        cur += ch;
        curWidth += w;
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}
