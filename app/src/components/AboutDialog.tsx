import { ExternalLink } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import logo from "../assets/logo.png";

const REPO_URL = "https://github.com/Sousaplex/blueline";

/** About / changelog modal. The changelog is inlined at build time (__CHANGELOG__). */
export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 pb-3">
          <img src={logo} alt="" className="size-10" />
          <div className="min-w-0">
            <DialogTitle className="text-base">Blueline</DialogTitle>
            <p className="text-xs text-muted-foreground">
              Version {__APP_VERSION__} · AI design for print collateral
            </p>
          </div>
          <a
            href={`${REPO_URL}/releases`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Releases <ExternalLink className="size-3" />
          </a>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto border-t pt-3 pr-1 text-sm">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: () => null, // the file's top "# Changelog" title is redundant with the dialog title
              h2: ({ children }) => (
                <h2 className="mb-1.5 mt-4 border-b pb-1 text-sm font-semibold first:mt-0">{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 className="mb-1 mt-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {children}
                </h3>
              ),
              p: (props) => <p className="mb-2 leading-relaxed text-muted-foreground" {...props} />,
              ul: (props) => <ul className="mb-2 list-disc space-y-1 pl-5" {...props} />,
              li: (props) => <li className="leading-relaxed marker:text-muted-foreground/50" {...props} />,
              a: (props) => (
                <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />
              ),
              code: (props) => (
                <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]" {...props} />
              ),
              strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
              hr: () => <hr className="my-3" />,
            }}
          >
            {__CHANGELOG__}
          </ReactMarkdown>
        </div>
      </DialogContent>
    </Dialog>
  );
}
