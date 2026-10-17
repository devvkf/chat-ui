import { useState, type ReactNode } from "react";
import { isValidElement } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

/** Flattens highlighted code nodes back to plain text for the copy button. */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeEl = isValidElement(children)
    ? (children as unknown as { props: { className?: string; children?: ReactNode } })
    : null;
  const className = codeEl?.props.className ?? "";
  const language = /language-(\S+)/.exec(className)?.[1] ?? "code";
  const text = extractText(codeEl?.props.children);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1">
        <span className="font-mono text-[0.68rem] tracking-wide text-muted-foreground">
          {language}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={copy}
          aria-label="Copy code"
          className="text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        >
          {copied ? <Check className="size-3 text-foreground" /> : <Copy className="size-3" />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[0.8rem] leading-relaxed">
        <code className={className}>{codeEl?.props.children}</code>
      </pre>
    </div>
  );
}

export function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body text-[0.92rem]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={(url) =>
          // Render only http(s) links; drop javascript: and other schemes.
          /^https?:\/\//i.test(url) ? defaultUrlTransform(url) : ""
        }
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Plain-text renderer for the user's own messages. */
export function UserText({ content }: { content: string }) {
  return (
    <p className="text-[0.92rem] leading-relaxed whitespace-pre-wrap break-words">
      {content}
    </p>
  );
}

export function MessageMeta({
  model,
  elapsed,
  className,
}: {
  model?: string | null;
  elapsed?: number | null;
  className?: string;
}) {
  if (!model && !elapsed) return null;
  return (
    <div className={cn("flex items-center gap-2 text-[0.68rem] text-muted-foreground", className)}>
      {model && <span className="max-w-40 truncate font-mono">{model}</span>}
      {elapsed != null && <span>{(elapsed / 1000).toFixed(1)}s</span>}
    </div>
  );
}
