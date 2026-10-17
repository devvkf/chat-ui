import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

export function PrivacyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-[1.4rem]">Privacy policy</DialogTitle>
          <DialogDescription>
            Relay is a local application. Here is exactly what happens to your data.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto text-[0.86rem] leading-relaxed text-foreground/90">
          <Section title="What stays on this machine">
            <p>
              Every chat, message, and setting — including your API key — is stored in a
              SQLite database at <code className="font-mono text-[0.8rem]">backend/data/relay.db</code>.
              Nothing is synced anywhere, and there is no account or sign-in.
            </p>
          </Section>

          <Separator />

          <Section title="What leaves this machine">
            <p>
              When you send a message, Relay forwards that message and the recent history of
              the current chat to the endpoint you configured, using the OpenAI chat
              completions format. That is the only network request the app makes with your
              data. Nothing else — not your other chats, your settings, or your API key —
              is sent anywhere.
            </p>
          </Section>

          <Separator />

          <Section title="Who else can see it">
            <p>
              The operator of the endpoint you configured. If you point Relay at a hosted
              provider, that provider's own privacy policy and data-retention rules apply to
              what it receives. Point it at a local server and nothing leaves your machine.
            </p>
          </Section>

          <Separator />

          <Section title="What Relay does not do">
            <ul className="list-disc space-y-1 pl-5">
              <li>No telemetry, analytics, or crash reporting.</li>
              <li>No ads, profiling, or model training on your chats.</li>
              <li>No accounts, cloud storage, or background syncing.</li>
              <li>No requests to any server other than the endpoint you set.</li>
            </ul>
          </Section>

          <Separator />

          <Section title="Your controls">
            <p>
              Delete all chats at any time from Settings → Data, export everything as JSON,
              or erase all trace simply by deleting the database file above while the app is
              stopped.
            </p>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[0.8rem] font-semibold tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}
