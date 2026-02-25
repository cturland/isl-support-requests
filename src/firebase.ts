import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBfHhz2suageQM40gs1Ts9e_bCmVrJ7WxM",
  authDomain: "isl-support-requests.firebaseapp.com",
  projectId: "isl-support-requests",
  storageBucket: "isl-support-requests.firebasestorage.app",
  messagingSenderId: "133399608135",
  appId: "1:133399608135:web:ff1374cbc107c9bcf3aa62"
};
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);