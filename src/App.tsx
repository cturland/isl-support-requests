import { useEffect, useMemo, useRef, useState } from "react";
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
  status: "green" | "amber" | "red" | "blue";
  note?: string;
  statusUpdatedAt: number;
  noteUpdatedAt?: number;
  toiletBreakApprovedAt?: number;
};

type ToiletBreakSession = {
  studentUid: string;
  studentName: string;
  studentEmail: string;
  leftAt: number;
  returnedAt?: number;
};

type ToiletBreakHistory = {
  [key: string]: ToiletBreakSession;
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
  
  // Toilet break tracking
  const [toiletBreakHistory, setToiletBreakHistory] = useState<ToiletBreakHistory>({});
  const [studentToiletStatus, setStudentToiletStatus] = useState<"idle" | "requested" | "approved" | "away">(() => {
    return (localStorage.getItem("studentToiletStatus") as any) ?? "idle";
  });
  const [toiletApprovalTime, setToiletApprovalTime] = useState<number>(() => {
    const stored = localStorage.getItem("toiletApprovalTime");
    return stored ? parseInt(stored) : 0;
  });
  const [expandedToiletHistory, setExpandedToiletHistory] = useState<boolean>(false);
  const [_timerTick, setTimerTick] = useState<number>(0);

  const provider = useMemo(() => new GoogleAuthProvider(), []);

  // Teacher sound toggle (persisted)
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    return localStorage.getItem("soundEnabled") === "true";
  });

  useEffect(() => {
    localStorage.setItem("soundEnabled", String(soundEnabled));
  }, [soundEnabled]);

  // Persist student toilet status
  useEffect(() => {
    localStorage.setItem("studentToiletStatus", studentToiletStatus);
  }, [studentToiletStatus]);

  useEffect(() => {
    localStorage.setItem("toiletApprovalTime", String(toiletApprovalTime));
  }, [toiletApprovalTime]);

  // Timer for toilet break countdown
  useEffect(() => {
    if (studentToiletStatus !== "approved") return;

    const interval = window.setInterval(() => {
      setTimerTick((t) => t + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [studentToiletStatus]);

  const prevTeacherRequestsRef = useRef<Record<string, StudentRequest>>({});

  function playSoftBeep() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.02;

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      window.setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 160);
    } catch {
      // ignore
    }
  }

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

  // Teachers watch their own request list (with urgent beep detection)
  useEffect(() => {
    if (!user) return;
    if (role !== "teacher") return;

    const teacherUid = user.uid;
    const reqRef = ref(db, `teacherRequests/${teacherUid}`);

    return onValue(reqRef, (snap) => {
      const next = (snap.val() as Record<string, StudentRequest>) ?? {};

      if (soundEnabled) {
        for (const [uid, req] of Object.entries(next)) {
          const prev = prevTeacherRequestsRef.current[uid];
          if (req?.status === "red" && prev?.status !== "red") {
            playSoftBeep();
            break;
          }
        }
      }

      prevTeacherRequestsRef.current = next;
      setTeacherRequests(next);
    });
  }, [role, user, soundEnabled]);

  // Teachers watch toilet break history
  useEffect(() => {
    if (!user) return;
    if (role !== "teacher") return;

    const teacherUid = user.uid;
    const toiletHistoryRef = ref(db, `toiletBreakHistory/${teacherUid}`);

    return onValue(toiletHistoryRef, (snap) => {
      const history = (snap.val() as ToiletBreakHistory) ?? {};
      setToiletBreakHistory(history);
    });
  }, [role, user]);

  // Student selects a teacher => create/update their request node under that teacher
  useEffect(() => {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    const studentUid = user.uid;
    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${studentUid}`);

    const now = Date.now();

    // Default: green
    void set(studentReqRef, {
      studentName: user.displayName ?? "Student",
      studentEmail: user.email ?? "",
      status: "green",
      note: "",
      statusUpdatedAt: now,
      noteUpdatedAt: now,
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

  // Student watches for toilet break approval
  useEffect(() => {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    const studentUid = user.uid;
    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${studentUid}`);

    return onValue(studentReqRef, (snap) => {
      const requestData = snap.val() as StudentRequest | null;
      if (requestData && requestData.toiletBreakApprovedAt && studentToiletStatus === "requested") {
        setStudentToiletStatus("approved");
        setToiletApprovalTime(requestData.toiletBreakApprovedAt);
      }
    });
  }, [role, selectedTeacherUid, user, studentToiletStatus]);

  async function handleSignIn() {
    await signInWithPopup(auth, provider);
  }

  function toggleNote(studentUid: string) {
    setExpandedNotes((prev) => ({ ...prev, [studentUid]: !prev[studentUid] }));
  }

  async function handleSignOut() {
    if (!user) return;

    // Teacher signs out: clear requests + remove presence + clear toilet history
    if (role === "teacher") {
      const teacherUid = user.uid;
      await remove(ref(db, `teacherRequests/${teacherUid}`));
      await remove(ref(db, `teachersOnline/${teacherUid}`));
      await remove(ref(db, `toiletBreakHistory/${teacherUid}`));
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
      studentName: user.displayName ?? "Student",
      studentEmail: user.email ?? "",
      status: newStatus,
      statusUpdatedAt: Date.now(),
    });
  }

  async function updateStudentNote(newNote: string) {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    setNote(newNote);

    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${user.uid}`);
    await update(studentReqRef, {
      studentName: user.displayName ?? "Student",
      studentEmail: user.email ?? "",
      note: newNote,
      noteUpdatedAt: Date.now(),
    });
  }

  async function requestToiletBreak() {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    setStudentToiletStatus("requested");

    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${user.uid}`);
    await update(studentReqRef, {
      status: "blue",
      statusUpdatedAt: Date.now(),
    });
  }

  async function approveToiletBreak(studentUid: string, studentRequest: StudentRequest) {
    if (!user) return;
    if (role !== "teacher") return;

    const teacherUid = user.uid;
    const now = Date.now();

    // Update student status to show approval
    const studentReqRef = ref(db, `teacherRequests/${teacherUid}/${studentUid}`);
    await update(studentReqRef, {
      status: "blue",
      statusUpdatedAt: now,
      toiletBreakApprovedAt: now,
    });

    // Add to toilet break history
    const historyRef = ref(db, `toiletBreakHistory/${teacherUid}/${studentUid}`);
    await set(historyRef, {
      studentUid,
      studentName: studentRequest.studentName,
      studentEmail: studentRequest.studentEmail,
      leftAt: now,
      returnedAt: null,
    });
  }

  async function returnFromToiletBreak(studentUid: string) {
    if (!user) return;
    if (role !== "student") return;
    if (!selectedTeacherUid) return;

    const now = Date.now();
    setStudentToiletStatus("idle");
    setToiletApprovalTime(0);

    // Update your status back to green
    const studentReqRef = ref(db, `teacherRequests/${selectedTeacherUid}/${user.uid}`);
    await update(studentReqRef, {
      status: "green",
      statusUpdatedAt: now,
    });

    // Mark return time in history
    const historyRef = ref(db, `toiletBreakHistory/${selectedTeacherUid}/${studentUid}`);
    const snap = await new Promise((resolve) => {
      const unsubscribe = onValue(historyRef, (snapshot) => {
        unsubscribe();
        resolve(snapshot.val());
      });
    });

    if (snap) {
      await update(historyRef, { returnedAt: now });
    }
  }

  function statusLabel(s: "green" | "amber" | "red" | "blue") {
    if (s === "green") return "Green (no help needed)";
    if (s === "amber") return "Amber (need help soon)";
    if (s === "red") return "Red (urgent help)";
    if (s === "blue") return "Blue (toilet break)";
  }

  function statusStyles(s: "green" | "amber" | "red" | "blue") {
    if (s === "red") return { background: "#fff5f5", borderLeft: "10px solid #dc2626" };
    if (s === "amber") return { background: "#fffbeb", borderLeft: "10px solid #f59e0b" };
    if (s === "blue") return { background: "#f0f9ff", borderLeft: "10px solid #0284c7" };
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

    // Group students by status
    const redStudents = entries.filter(([_, r]) => r.status === "red");
    const amberStudents = entries.filter(([_, r]) => r.status === "amber");
    const blueStudents = entries.filter(([_, r]) => r.status === "blue");
    const greenStudents = entries.filter(([_, r]) => r.status === "green");

    // Sort each group by statusUpdatedAt (oldest first, most recent at bottom)
    const sortByTime = (a: [string, StudentRequest], b: [string, StudentRequest]) => {
      const ta = a[1].statusUpdatedAt ?? 0;
      const tb = b[1].statusUpdatedAt ?? 0;
      return ta - tb;
    };

    redStudents.sort(sortByTime);
    amberStudents.sort(sortByTime);
    blueStudents.sort(sortByTime);
    greenStudents.sort(sortByTime);

    const renderColumn = (students: [string, StudentRequest][], columnStatus: "red" | "amber" | "blue" | "green") => (
      <div style={{ flex: 1, minWidth: 0 }}>
        <h4 style={{ margin: "0 0 12px 0", textTransform: "capitalize" }}>{columnStatus}</h4>
        {students.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 13 }}>No students</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {students.map(([studentUid, r]) => (
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
                <div style={{ fontSize: 16, fontWeight: 600 }}>{r.studentName || "Unnamed student"}</div>
                <div style={{ opacity: 0.8, fontSize: 13 }}>{r.studentEmail || "No email available"}</div>
                {expandedNotes[studentUid] && r.note ? (
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    <strong>Note:</strong> {r.note}
                  </div>
                ) : null}
                <div style={{ marginTop: 8, opacity: 0.7, fontSize: 11 }}>
                  {new Date(r.statusUpdatedAt).toLocaleTimeString()}
                </div>
                {columnStatus === "blue" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      approveToiletBreak(studentUid, r);
                    }}
                    style={{
                      marginTop: 8,
                      padding: "6px 12px",
                      backgroundColor: "#0284c7",
                      color: "white",
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    Approve
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );

    const formatDuration = (ms: number) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}m ${secs}s`;
    };

    return (
      <div style={{ maxWidth: 1400, margin: "40px auto", textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
          <div>
            <h2>Teacher Dashboard</h2>
            <div>
              Signed in as <strong>{user.displayName}</strong> ({user.email})
            </div>
            <div style={{ marginTop: 10 }}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => setSoundEnabled(e.target.checked)}
                />
                Sound alert for urgent (red)
              </label>
            </div>
          </div>
          <button onClick={handleSignOut}>Sign out (clears all requests)</button>
        </div>

        <hr />

        <h3>Live requests</h3>
        {redStudents.length === 0 && amberStudents.length === 0 && blueStudents.length === 0 && greenStudents.length === 0 ? (
          <p>No students currently connected.</p>
        ) : (
          <div style={{ display: "flex", gap: 16 }}>
            {renderColumn(redStudents, "red")}
            {renderColumn(amberStudents, "amber")}
            {renderColumn(blueStudents, "blue")}
            {renderColumn(greenStudents, "green")}
          </div>
        )}

        <hr style={{ marginTop: 32 }} />

        <div>
          <button
            onClick={() => setExpandedToiletHistory(!expandedToiletHistory)}
            style={{
              padding: "10px 16px",
              backgroundColor: "#f3f4f6",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {expandedToiletHistory ? "▼" : "▶"} Toilet Break History
          </button>

          {expandedToiletHistory && (
            <div style={{ marginTop: 16 }}>
              {Object.keys(toiletBreakHistory).length === 0 ? (
                <p style={{ opacity: 0.6 }}>No toilet breaks recorded.</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #ddd" }}>
                      <th style={{ padding: "8px", textAlign: "left", fontWeight: 600 }}>Student Name</th>
                      <th style={{ padding: "8px", textAlign: "left", fontWeight: 600 }}>Left At</th>
                      <th style={{ padding: "8px", textAlign: "left", fontWeight: 600 }}>Returned At</th>
                      <th style={{ padding: "8px", textAlign: "left", fontWeight: 600 }}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(toiletBreakHistory).map(([_, session]) => (
                      <tr key={session.studentUid} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "8px" }}>{session.studentName}</td>
                        <td style={{ padding: "8px" }}>{new Date(session.leftAt).toLocaleTimeString()}</td>
                        <td style={{ padding: "8px" }}>
                          {session.returnedAt
                            ? new Date(session.returnedAt).toLocaleTimeString()
                            : <span style={{ opacity: 0.6 }}>Still away</span>}
                        </td>
                        <td style={{ padding: "8px" }}>
                          {session.returnedAt
                            ? formatDuration(session.returnedAt - session.leftAt)
                            : <span style={{ opacity: 0.6 }}>In progress</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
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

          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Toilet Break</div>
            {studentToiletStatus === "idle" ? (
              <button onClick={requestToiletBreak} style={{ padding: "10px 16px", backgroundColor: "#3b82f6", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}>
                Request Toilet Break
              </button>
            ) : studentToiletStatus === "requested" ? (
              <div style={{ padding: 12, backgroundColor: "#fef3c7", borderLeft: "4px solid #f59e0b", borderRadius: 6 }}>
                Toilet break requested. Waiting for teacher approval...
              </div>
            ) : studentToiletStatus === "approved" ? (
              <div>
                <div style={{ padding: 12, backgroundColor: "#d1fae5", borderLeft: "4px solid #10b981", borderRadius: 6, marginBottom: 8 }}>
                  ✓ Toilet break approved! Timer started.
                </div>
                <div style={{ fontSize: 14, marginBottom: 8 }}>
                  Time away: <strong>{Math.floor((Date.now() - toiletApprovalTime) / 1000)}s</strong>
                </div>
                <button onClick={() => returnFromToiletBreak(user.uid)} style={{ padding: "10px 16px", backgroundColor: "#10b981", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}>
                  I'm Back
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}