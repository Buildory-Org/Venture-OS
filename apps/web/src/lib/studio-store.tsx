"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { demoData, type StudioData } from "./studio-demo";

const STORAGE_KEY = "venture-studio-demo-v2";
const USER_KEY = "venture-studio-demo-user";

type StudioContextValue = {
  data: StudioData;
  currentUserId: string;
  mode: "demo" | "connected";
  workspaceName: string;
  role: string;
  setCurrentUserId: (id: string) => void;
  updateSection: <K extends keyof StudioData>(section: K, updater: (current: StudioData[K]) => StudioData[K]) => void;
  resetDemo: () => void;
  ready: boolean;
};

const StudioContext = createContext<StudioContextValue | null>(null);

export function StudioProvider({ children, mode = "demo", initialData, initialUserId, workspaceName = "Meridian Studio", role = "Demo identity" }: { children: React.ReactNode; mode?: "demo" | "connected"; initialData?: StudioData; initialUserId?: string; workspaceName?: string; role?: string }) {
  const [data, setData] = useState<StudioData>(initialData ?? demoData);
  const [currentUserId, setCurrentUserId] = useState(initialUserId ?? "divyansh");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (mode === "connected") return;
    const frame = requestAnimationFrame(() => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as StudioData;
          if (Array.isArray(parsed.tasks) && Array.isArray(parsed.ventures)) setData({ ...demoData, ...parsed });
        }
        const selectedUser = localStorage.getItem(USER_KEY);
        if (selectedUser && demoData.people.some((person) => person.id === selectedUser)) setCurrentUserId(selectedUser);
      } catch {
        // A malformed local demo snapshot falls back to the bundled seed.
      }
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  useEffect(() => {
    if (ready && mode === "demo") localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, ready, mode]);

  useEffect(() => {
    if (ready && mode === "demo") localStorage.setItem(USER_KEY, currentUserId);
  }, [currentUserId, ready, mode]);

  const updateSection: StudioContextValue["updateSection"] = (section, updater) => {
    if (mode === "connected") throw new Error("Connected workspace changes must use the API.");
    setData((current) => ({
      ...current,
      [section]: updater(current[section]),
      audit: section === "audit" ? current.audit : [{ id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, actorId: currentUserId, action: `Updated ${section} in demo workspace`, at: new Date().toISOString(), scope: "Meridian Studio" }, ...current.audit],
    }));
  };

  const resetDemo = () => {
    if (mode === "connected") return;
    setData(demoData);
    setCurrentUserId("divyansh");
  };

  return <StudioContext.Provider value={{ data: mode === "connected" ? initialData ?? data : data, currentUserId, mode, workspaceName, role, setCurrentUserId, updateSection, resetDemo, ready: mode === "connected" || ready }}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const value = useContext(StudioContext);
  if (!value) throw new Error("StudioProvider is missing");
  return value;
}
