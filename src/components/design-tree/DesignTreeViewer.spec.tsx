import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { DesignTreeViewer } from './DesignTreeViewer';

const nodes = [
  {
    id: 'body',
    kind: 'part' as const,
    name: 'Main body',
    params: ['width'],
  },
  {
    id: 'holes',
    kind: 'operation' as const,
    name: 'Mounting holes',
    parentId: 'body',
    params: ['hole_diameter'],
  },
];

describe('DesignTreeViewer', () => {
  it('renders nested nodes and selects a part', () => {
    const onSelectNode = vi.fn();
    render(
      <DesignTreeViewer
        nodes={nodes}
        warnings={[]}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
      />,
    );

    expect(screen.getByText('Mounting holes')).toBeInTheDocument();
    const partButton = screen.getByText('Main body').closest('button');
    expect(partButton).not.toBeNull();
    fireEvent.click(partButton!);
    expect(onSelectNode).toHaveBeenCalledWith('body');
  });

  it('offers show all for an active filter', () => {
    const onSelectNode = vi.fn();
    render(
      <DesignTreeViewer
        nodes={nodes}
        warnings={[]}
        selectedNodeId="body"
        onSelectNode={onSelectNode}
      />,
    );

    expect(screen.getByText('Main body').closest('button')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(onSelectNode).toHaveBeenCalledWith(null);
  });
});
