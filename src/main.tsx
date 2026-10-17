import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import { ChatProvider } from "@/lib/store";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ChatProvider>
        <App />
        <Toaster position="bottom-right" richColors closeButton />
      </ChatProvider>
    </ThemeProvider>
  </StrictMode>,
);
