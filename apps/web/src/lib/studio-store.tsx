"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { demoData, type StudioData } from "./studio-demo";

const STORAGE_KEY = "venture-studio-demo-v2";
const USER_KEY = "venture-studio-demo-user";

type StudioContextValue = {
  data: StudioData;
  currentUserId: string;
  setCurrentUserId: (id: string) => void;
  updateSection: <K extends keyof StudioData>(section: K, updater: (current: StudioData[K]) => StudioData[K]) => void;
  resetDemo: () => void;
  ready: boolean;
};

const StudioContext = createContext<StudioContextValue | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<StudioData>(demoData);
  const [currentUserId, setCurrentUserId] = useState("divyansh");
  const [ready, setReady] = useState(false);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, ready]);

  useEffect(() => {
    if (ready) localStorage.setItem(USER_KEY, currentUserId);
  }, [currentUserId, ready]);

  const updateSection: StudioContextValue["updateSection"] = (section, updater) => {
    setData((current) => ({
      ...current,
      [section]: updater(current[section]),
      audit: section === "audit" ? current.audit : [{ id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, actorId: currentUserId, action: `Updated ${section} in demo workspace`, at: new Date().toISOString(), scope: "Meridian Studio" }, ...current.audit],
    }));
  };

  const resetDemo = () => {
    setData(demoData);
    setCurrentUserId("divyansh");
  };

  return <StudioContext.Provider value={{ data, currentUserId, setCurrentUserId, updateSection, resetDemo, ready }}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const value = useContext(StudioContext);
  if (!value) throw new Error("StudioProvider is missing");
  return value;
}
