import React from 'react';

/**
 * The composed agent graph, drawn as layered columns left → right.
 * Layers come from capability phases, so the picture is the actual execution order — not a diagram
 * someone drew by hand that can drift from the code.
 */
const NODE_W = 196;
const NODE_H = 58;
const GAP_X = 82;
const GAP_Y = 14;
const PAD = 22;

const PHASE_LABEL = {
  12: 'Brief',
  14: 'PRD',
  16: 'UX',
  18: 'Architecture',
  22: 'Stories',
  32: 'Implement',
  10: 'Analyse',
  20: 'Prepare',
  25: 'Custom',
  30: 'Generate',
  40: 'Trace',
  50: 'Validate',
};

export default function Graph({ graph, statuses = {}, selected, onSelect }) {
  if (!graph?.nodes?.length) return null;

  const layers = graph.layers?.length
    ? graph.layers
    : [{ phase: 0, nodes: graph.nodes.map((n) => n.nodeId) }];

  const positions = new Map();
  layers.forEach((layer, columnIndex) => {
    layer.nodes.forEach((nodeId, rowIndex) => {
      positions.set(nodeId, {
        x: PAD + columnIndex * (NODE_W + GAP_X),
        y: PAD + 22 + rowIndex * (NODE_H + GAP_Y),
      });
    });
  });

  const tallest = Math.max(...layers.map((layer) => layer.nodes.length));
  const width = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X;
  const height = PAD * 2 + 22 + tallest * (NODE_H + GAP_Y);

  return (
    <div className="graph-scroll">
      <svg width={width} height={height} style={{ display: 'block' }}>
        {graph.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const finished = (status) => status === 'done' || status === 'reused';
          const active = finished(statuses[edge.from]) && (statuses[edge.to] === 'running' || finished(statuses[edge.to]));
          return (
            <path
              key={index}
              className={`gedge ${active ? 'active' : ''}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              markerEnd="url(#arrow)"
            />
          );
        })}

        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 1 L 7 4 L 0 7 z" style={{ fill: 'var(--edge)' }} />
          </marker>
        </defs>

        {layers.map((layer, index) => (
          <text key={`l${layer.phase}`} className="glayer" x={PAD + index * (NODE_W + GAP_X)} y={PAD - 4}>
            {PHASE_LABEL[layer.phase] || `Phase ${layer.phase}`}
          </text>
        ))}

        {graph.nodes.map((node) => {
          const position = positions.get(node.nodeId);
          if (!position) return null;
          const status = statuses[node.nodeId] || 'pending';
          const isSelected = selected === node.nodeId;
          return (
            <g
              key={node.nodeId}
              transform={`translate(${position.x}, ${position.y})`}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={() => onSelect?.(node.nodeId)}
            >
              <rect
                className={`gnode ${status}`}
                width={NODE_W}
                height={NODE_H}
                rx={9}
                strokeWidth={isSelected ? 2 : 1}
                stroke={isSelected ? 'var(--accent)' : undefined}
              />
              <text className="glabel" x={12} y={22}>
                {truncate(node.name, 24)}
              </text>
              <text className="gsub" x={12} y={38}>
                {truncate(node.capability, 30)}
              </text>
              <text className="gsub" x={12} y={50} fill={statusColour(status)}>
                {status}
                {node.source === 'generated' ? ' · generated agent' : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function statusColour(status) {
  return {
    done: 'var(--pass)',
    reused: 'var(--info)',
    running: 'var(--info)',
    failed: 'var(--fail)',
    skipped: 'var(--warn)',
    waiting: 'var(--warn)',
  }[status] || 'var(--text-faint)';
}
