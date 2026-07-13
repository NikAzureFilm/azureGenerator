import { KeyboardEvent, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Content } from '@shared/types';

interface AgentComposerProps {
  onSubmit: (content: Content) => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  stopGenerating?: () => void;
  onFocus?: () => void;
}

// Minimal composer for design-agent conversations: plain text in, no model
// pickers or attachment controls — the agent drives image generation itself.
export function AgentComposer({
  onSubmit,
  isLoading = false,
  disabled = false,
  placeholder = 'Describe what you want to build...',
  stopGenerating,
  onFocus,
}: AgentComposerProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSubmit = !disabled && !isLoading && input.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ text: input.trim() });
    setInput('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex w-full items-end gap-2 rounded-xl border border-adam-neutral-700 bg-adam-neutral-800 p-2">
      <Textarea
        ref={textareaRef}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="max-h-40 min-h-[2.5rem] flex-1 resize-none border-none bg-transparent text-sm text-adam-text-primary shadow-none focus-visible:ring-0"
      />
      {isLoading && stopGenerating ? (
        <Button
          type="button"
          size="icon"
          aria-label="Stop generating"
          onClick={stopGenerating}
          className="h-9 w-9 shrink-0 rounded-full"
        >
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          aria-label="Send message"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            'h-9 w-9 shrink-0 rounded-full',
            !canSubmit && 'opacity-50',
          )}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
