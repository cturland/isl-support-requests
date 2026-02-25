import { useEffect, useMemo, useState } from "react";
import "./App.css";

import { auth, db } from "./firebase";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "firebase/auth";

import type { User } from "firebase/auth";

import { onValue, ref, set, update, remove, onDisconnect } from "firebase/database";

type TeacherOnline = {
  displayName: string;
  email: string;
  lastSeen: number;
};

type StudentRequest = {
  studentName: string;
  studentEmail: string;
  status: "green" | "amber" | "red";
  note?: string;
  updatedAt: number;
};

function emailDomain(email: string | null | undefined) {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at).toLowerCase() : "";
}

function isTeacher(email: string | null | undefined) {
  return emailDomain(email) === "@isl.ch";
}

function isStudent(email: string | null | undefined) {
  return emailDomain(email) === "@islstudent.ch";
}



export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<"teacher" | "student" | "unknown">("unknown");
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});

  const [teachersOnline, setTeachersOnline] = useState<Record<string, TeacherOnline>>({});
  const [selectedTeacherUid, setSelectedTeacherUid] = useState<string>("");

  const [status, setStatus] = useState<"green" | "amber" | "red">("green");
  const [note, setNote] = useState<string>("");

  const [teacherRequests, setTeacherRequests] = useState<Record<string, StudentRequest>>({});

  const provider = useMemo(() => new GoogleAuthProvider(), []);

  // Track auth state and derive role from email domain
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);

      if (!u) {
        setRole("unknown");
        setSelectedTeacherUid("");
        setTeachersOnline({});
        setTeacherRequests({});
        setStatus("green");
        setNote("");
        return;
      }

      const email = u.email ?? "";
      if (isTeacher(email)) setRole("teacher");
      else if (isStudent(email)) setRole("student");
      else setRole("unknown");
    });
  }, []);

  // If signed in but wrong domain, immediately sign out
  useEffect(() => {
    if (!user) return;
    if (role !== "unknown") return;
    void signOut(auth);
  }, [role, user]);

  // Teacher presence (online list)
  useEffect(() => {
    if (!user) return;
    if (role !== "teacher") return;

    const teacherUid = user.uid;
    const onlineRef = ref(db, `teachersOnline/${teacherUid}`);

    void set(onlineRef, {
      displayName: user.displayName ?? "Teacher",
      email: user.email ?? "",
      lastSeen: Date.now(),
    });

    void onDisconnect(onlineRef).remove();

    const interval = window.setInterval(() => {
      void update(onlineRef, { lastSeen: Date.now() });
    }, 15000);

    return () => window.clearInterval(interval);
  }, [role, user]);

  // Students watch teachersOnline to populate dropdown
  useEffect(() => {
    if (!user) return;
    if (role !== "student") return;

    const teachersRef = ref(db, "teachersOnline");
    return onValue(teachersRef, (snap) => {
      setTeachersOnline((snap.val() as Record<string, TeacherOnline>) ?? {});
    });
  }, [role, user]);

  // Teachers watch their own request list
  useEffect(() => {
    if (!user) return;
    if (role !== "teacher") return;

    const teacherUid = user.uid;
    const reqRef = ref(db, `teacherRequests/${teacherUid}`);
    return onValue(reqRef, (snap) => {
      setTeacherRequests((snap.val() as Record<string, StudentRequest>) ?? {});
    });
  }, [role, user]);

  // Student selects a teacher => create/update their request node under that teacher
  useEffect(() => {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    const studentUid = user.uid;
    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${studentUid}`);

    // Default: green
    void set(studentReqRef, {
      studentName: user.displayName ?? "Student",
      studentEmail: user.email ?? "",
      status: "green",
      note: "",
      updatedAt: Date.now(),
    });

    // Remove automatically if student disconnects
    void onDisconnect(studentReqRef).remove();

    setStatus("green");
    setNote("");

    // If student changes teacher selection, remove old node
    return () => {
      void remove(studentReqRef);
    };
  }, [role, selectedTeacherUid, user]);

  async function handleSignIn() {
    await signInWithPopup(auth, provider);
  }

  function toggleNote(studentUid: string) {
  setExpandedNotes((prev) => ({ ...prev, [studentUid]: !prev[studentUid] }));
}

  async function handleSignOut() {
    if (!user) return;

    // Teacher signs out: clear requests + remove presence
    if (role === "teacher") {
      const teacherUid = user.uid;
      await remove(ref(db, `teacherRequests/${teacherUid}`));
      await remove(ref(db, `teachersOnline/${teacherUid}`));
    }

    // Student signs out: remove their request node (if they selected a teacher)
    if (role === "student" && selectedTeacherUid) {
      await remove(ref(db, `teacherRequests/${selectedTeacherUid}/${user.uid}`));
    }

    await signOut(auth);
  }

  async function updateStudentStatus(newStatus: "green" | "amber" | "red") {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    setStatus(newStatus);

    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${user.uid}`);
    await update(studentReqRef, {
      status: newStatus,
      note,
      updatedAt: Date.now(),
    });
  }

  async function updateStudentNote(newNote: string) {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    setNote(newNote);

    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${user.uid}`);
    await update(studentReqRef, {
      note: newNote,
      updatedAt: Date.now(),
    });
  }

  function statusLabel(s: "green" | "amber" | "red") {
    if (s === "green") return "Green (no help needed)";
    if (s === "amber") return "Amber (need help soon)";
    return "Red (urgent help)";
  }

  function statusRank(s: "green" | "amber" | "red") {
    return s === "red" ? 0 : s === "amber" ? 1 : 2;
  }

  function statusStyles(s: "green" | "amber" | "red") {
    // Light backgrounds + coloured left border (readable, not aggressive)
    if (s === "red") return { background: "#fff5f5", borderLeft: "10px solid #dc2626" };
    if (s === "amber") return { background: "#fffbeb", borderLeft: "10px solid #f59e0b" };
    return { background: "#f0fdf4", borderLeft: "10px solid #16a34a" };
  }

  // Signed out view
  if (!user) {
    return (
      <div style={{ maxWidth: 720, margin: "40px auto", textAlign: "left" }}>
        <h2>Support Requests</h2>
        <p>Sign in with your school Google account.</p>
        <button onClick={handleSignIn}>Sign in with Google</button>
      </div>
    );
  }

  // Wrong domain view
  if (role === "unknown") {
    return (
      <div style={{ maxWidth: 720, margin: "40px auto", textAlign: "left" }}>
        <h2>Support Requests</h2>
        <p>
          This app only allows:
          <br />
          Teachers: <strong>@isl.ch</strong>
          <br />
          Students: <strong>@islstudent.ch</strong>
        </p>
        <button onClick={handleSignOut}>Sign out</button>
      </div>
    );
  }

  // Teacher dashboard
  if (role === "teacher") {
    const entries = Object.entries(teacherRequests);

    // Sort: red first, amber second, green last; within each, oldest request first (smallest updatedAt)
    entries.sort((a, b) => {
      const ra = statusRank(a[1].status);
      const rb = statusRank(b[1].status);
      if (ra !== rb) return ra - rb;

      const ta = a[1].updatedAt ?? 0;
      const tb = b[1].updatedAt ?? 0;
      if (ta !== tb) return ta - tb; // older (waiting longer) first

      return a[1].studentName.localeCompare(b[1].studentName);
    });

    return (
      <div style={{ maxWidth: 980, margin: "40px auto", textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
          <div>
            <h2>Teacher Dashboard</h2>
            <div>
              Signed in as <strong>{user.displayName}</strong> ({user.email})
            </div>
          </div>
          <button onClick={handleSignOut}>Sign out (clears all requests)</button>
        </div>

        <hr />

        <h3>Live requests</h3>
        {entries.length === 0 ? (
          <p>No students currently connected.</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
            {entries.map(([studentUid, r]) => (
                <div
                  key={studentUid}
                  onClick={() => toggleNote(studentUid)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") toggleNote(studentUid);
                  }}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: 10,
                    cursor: "pointer",
                    padding: 12,
                    ...statusStyles(r.status),
                  }}
                >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>{r.studentName}</div>
                    <div style={{ opacity: 0.8 }}>{r.studentEmail}</div>
                  </div>
                  <div style={{ fontWeight: 700 }}>{statusLabel(r.status)}</div>
                  <div style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>
                    Click to {expandedNotes[studentUid] ? "hide" : "view"} note
                  </div>
                </div>
                {expandedNotes[studentUid] && r.note ? (
                  <div style={{ marginTop: 8 }}>
                    <strong>Note:</strong> {r.note}
                  </div>
                ) : null}
                <div style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>
                  Updated: {new Date(r.updatedAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Student view
  const teacherOptions = Object.entries(teachersOnline).map(([uid, t]) => ({ uid, ...t }));
  teacherOptions.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", textAlign: "left" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
        <div>
          <h2>Student Support</h2>
          <div>
            Signed in as <strong>{user.displayName}</strong> ({user.email})
          </div>
        </div>
        <button onClick={handleSignOut}>Sign out</button>
      </div>

      <hr />

      <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
        Select a teacher (only teachers currently signed in will appear)
      </label>
      <select
        value={selectedTeacherUid}
        onChange={(e) => setSelectedTeacherUid(e.target.value)}
        style={{ width: "100%", padding: 10, borderRadius: 8 }}
      >
        <option value="">-- Select --</option>
        {teacherOptions.map((t) => (
          <option key={t.uid} value={t.uid}>
            {t.displayName} ({t.email})
          </option>
        ))}
      </select>

      {!selectedTeacherUid ? (
        <p style={{ marginTop: 12 }}>Select a teacher to join their support board.</p>
      ) : (
        <>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Set your status</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => updateStudentStatus("green")} disabled={status === "green"}>
                Green
              </button>
              <button onClick={() => updateStudentStatus("amber")} disabled={status === "amber"}>
                Amber
              </button>
              <button onClick={() => updateStudentStatus("red")} disabled={status === "red"}>
                Red
              </button>
            </div>
            <div style={{ marginTop: 8, opacity: 0.85 }}>
              Current: <strong>{statusLabel(status)}</strong>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
              Optional note (what do you need help with?)
            </label>
            <textarea
              value={note}
              onChange={(e) => updateStudentNote(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: 10, borderRadius: 8 }}
              placeholder="Example: I am stuck on question 4 / debugging my loop / etc."
            />
          </div>
        </>
      )}
    </div>
  );
}