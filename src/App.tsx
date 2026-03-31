import { useState, useEffect, useRef } from 'react';
import { Camera, UserPlus, ClipboardList, CheckCircle2, AlertCircle, Loader2, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { loadModels, getFaceDescriptor } from './lib/faceApi';
import { User, AttendanceRecord } from './types';
import { format } from 'date-fns';
import * as faceapi from 'face-api.js';
import { io } from 'socket.io-client';

const socket = io();

export default function App() {
  const [isModelsLoaded, setIsModelsLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<'attendance' | 'register' | 'history'>('attendance');
  const [historyView, setHistoryView] = useState<'logs' | 'summary'>('logs');
  const [users, setUsers] = useState<User[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ success: boolean; message: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isAbsenceDialogOpen, setIsAbsenceDialogOpen] = useState(false);
  const [selectedUserForAbsence, setSelectedUserForAbsence] = useState<string>('');

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    });
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        await loadModels();
        setIsModelsLoaded(true);
      } catch (error) {
        console.error('Failed to load models:', error);
      }
    };
    init();

    // Socket listeners for real-time updates
    socket.on('initial_state', ({ users, attendance }) => {
      setUsers(users);
      setAttendance(attendance);
    });

    socket.on('user_registered', (user) => {
      setUsers(prev => [...prev, user]);
    });

    socket.on('attendance_added', (record) => {
      setAttendance(prev => {
        // Prevent duplicates if already added locally
        if (prev.some(r => r.id === record.id)) return prev;
        return [record, ...prev];
      });
    });

    socket.on('absents_marked', (records) => {
      setAttendance(prev => {
        const newRecords = records.filter((r: any) => !prev.some(p => p.id === r.id));
        return [...newRecords, ...prev];
      });
    });

    return () => {
      socket.off('initial_state');
      socket.off('user_registered');
      socket.off('attendance_added');
      socket.off('absents_marked');
    };
  }, []);

  const [cameraError, setCameraError] = useState<string | null>(null);

  const startCamera = async () => {
    setCameraError(null);
    
    // Stop any existing tracks before starting a new one
    stopCamera();

    const constraints = [
      { 
        video: { 
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } 
      },
      { video: { facingMode: 'user' } },
      { video: true }
    ];

    let lastError: any = null;

    for (const constraint of constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraint);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          return; // Success!
        }
      } catch (error: any) {
        lastError = error;
        console.warn('Camera constraint failed, trying next...', constraint, error);
        // If it's a permission error, don't bother trying other constraints
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          break;
        }
      }
    }

    // If we reach here, all attempts failed
    if (lastError) {
      console.error('Final camera access error:', lastError);
      if (lastError.name === 'NotAllowedError' || lastError.name === 'PermissionDeniedError') {
        setCameraError('Camera access was denied. Please enable camera permissions in your browser settings and refresh the page.');
      } else if (lastError.name === 'NotReadableError' || lastError.name === 'TrackStartError') {
        setCameraError('The camera is already in use by another application or tab. Please close other apps using the camera and try again.');
      } else {
        setCameraError('Could not access camera. Please ensure your camera is connected and not being used by another app.');
      }
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
  };

  const markAbsents = () => {
    const today = new Date().toDateString();
    const presentUserIds = new Set(
      attendance
        .filter(r => new Date(r.timestamp).toDateString() === today && r.status === 'present')
        .map(r => r.userId)
    );

    const absentRecords: AttendanceRecord[] = users
      .filter(u => !presentUserIds.has(u.id))
      .map(u => ({
        id: crypto.randomUUID(),
        userId: u.id,
        userName: u.name,
        timestamp: new Date().toISOString(),
        status: 'absent'
      }));

    if (absentRecords.length > 0) {
      socket.emit('mark_absents', absentRecords);
      setScanResult({ success: true, message: `${absentRecords.length} users marked as absent.` });
      setTimeout(() => setScanResult(null), 3000);
    }
  };

  const markSingleUserAbsent = (userId: string) => {
    const user = users.find(u => u.id === userId);
    if (!user) return;

    const today = new Date().toDateString();
    const alreadyMarked = attendance.some(
      r => r.userId === userId && new Date(r.timestamp).toDateString() === today
    );

    if (alreadyMarked) {
      setScanResult({ success: false, message: `${user.name} already has a record for today.` });
      setTimeout(() => setScanResult(null), 3000);
      return;
    }

    const newRecord: AttendanceRecord = {
      id: crypto.randomUUID(),
      userId: user.id,
      userName: user.name,
      timestamp: new Date().toISOString(),
      status: 'absent'
    };

    socket.emit('mark_absent', newRecord);
    setScanResult({ success: true, message: `${user.name} marked as absent.` });
    setIsAbsenceDialogOpen(false);
    setSelectedUserForAbsence('');
    setTimeout(() => setScanResult(null), 3000);
  };

  const exportToCSV = () => {
    if (attendance.length === 0) {
      setScanResult({ success: false, message: 'No records to export.' });
      setTimeout(() => setScanResult(null), 3000);
      return;
    }
    
    const headers = ['User Name', 'User ID', 'Date', 'Time', 'Status', 'Confidence (%)'];
    const rows = attendance.map(record => [
      record.userName,
      record.userId,
      format(new Date(record.timestamp), 'yyyy-MM-dd'),
      format(new Date(record.timestamp), 'HH:mm:ss'),
      record.status,
      record.confidence ? `${record.confidence}%` : '-'
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `attendance_report_${format(new Date(), 'yyyy-MM-dd')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    setScanResult({ success: true, message: 'Exporting CSV...' });
    setTimeout(() => setScanResult(null), 3000);
  };

  const getDailySummary = () => {
    const today = new Date().toDateString();
    return users.map(user => {
      const record = attendance.find(
        r => r.userId === user.id && new Date(r.timestamp).toDateString() === today
      );
      return {
        ...user,
        status: record ? record.status : 'pending'
      };
    });
  };

  useEffect(() => {
    if (activeTab === 'attendance' || activeTab === 'register') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [activeTab]);

  const handleRegister = async () => {
    if (!newName || !videoRef.current) return;
    setIsRegistering(true);
    setScanResult(null);
    
    try {
      // Small delay to ensure camera frame is stable
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const descriptor = await getFaceDescriptor(videoRef.current);
      if (descriptor) {
        const newUser: User = {
          id: crypto.randomUUID(),
          name: newName,
          descriptor: Array.from(descriptor),
          createdAt: new Date().toISOString(),
        };
        socket.emit('register_user', newUser);
        setNewName('');
        setScanResult({ success: true, message: `Successfully registered ${newUser.name}` });
      } else {
        setScanResult({ success: false, message: 'No face detected. Please ensure your face is clearly visible and try again.' });
      }
    } catch (error) {
      console.error('Registration error:', error);
      setScanResult({ success: false, message: 'Registration failed. Please try again.' });
    } finally {
      setIsRegistering(false);
      // Keep success message longer, error message shorter
      setTimeout(() => setScanResult(null), 4000);
    }
  };

  const handleAttendance = async () => {
    if (!videoRef.current || isScanning) return;
    setIsScanning(true);

    try {
      const descriptor = await getFaceDescriptor(videoRef.current);
      if (!descriptor) {
        setScanResult({ success: false, message: 'No face detected.' });
        return;
      }

      // Find matching user
      let bestMatch: User | null = null;
      let minDistance = 0.6;

      for (const user of users) {
        const userDescriptor = new Float32Array(user.descriptor);
        const distance = faceapi.euclideanDistance(descriptor, userDescriptor);
        if (distance < minDistance) {
          minDistance = distance;
          bestMatch = user;
        }
      }

      if (bestMatch) {
        const confidence = Math.round((1 - minDistance) * 100);
        const newRecord: AttendanceRecord = {
          id: crypto.randomUUID(),
          userId: bestMatch.id,
          userName: bestMatch.name,
          timestamp: new Date().toISOString(),
          status: 'present',
          confidence: confidence,
        };
        socket.emit('add_attendance', newRecord);
        setScanResult({ success: true, message: `Welcome, ${bestMatch.name}! (${confidence}% match)` });
      } else {
        setScanResult({ success: false, message: 'User not recognized.' });
      }
    } catch (error) {
      setScanResult({ success: false, message: 'Scanning failed.' });
    } finally {
      setIsScanning(false);
      setTimeout(() => setScanResult(null), 3000);
    }
  };

  if (!isModelsLoaded) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center text-white font-sans">
        <Loader2 className="w-12 h-12 animate-spin text-orange-500 mb-4" />
        <h1 className="text-2xl font-light tracking-widest uppercase">Initializing AI Models</h1>
        <p className="text-zinc-500 mt-2">Loading face recognition system...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Header */}
      <header className="border-b border-zinc-800/50 p-6 flex justify-between items-center backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-orange-500 rounded-full flex items-center justify-center shadow-lg shadow-orange-500/20">
            <Camera className="text-black w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">AI Attendance</h1>
            <p className="text-[10px] text-zinc-500 uppercase tracking-[0.2em]">Smart System</p>
          </div>
        </div>
        
        <nav className="flex gap-1 bg-zinc-900/50 p-1 rounded-full border border-zinc-800">
          {deferredPrompt && (
            <button
              onClick={handleInstallClick}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold bg-white text-black hover:bg-orange-500 transition-all mr-2"
            >
              Install App
            </button>
          )}
          {[
            { id: 'attendance', icon: Camera, label: 'Scan' },
            { id: 'register', icon: UserPlus, label: 'Register' },
            { id: 'history', icon: ClipboardList, label: 'History' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                activeTab === tab.id 
                  ? 'bg-orange-500 text-black shadow-lg shadow-orange-500/20' 
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-6xl mx-auto p-6 md:p-12">
        <AnimatePresence mode="wait">
          {activeTab === 'attendance' && (
            <motion.div
              key="attendance"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="grid lg:grid-cols-2 gap-12 items-center"
            >
              <div className="space-y-8">
                <div className="space-y-4">
                  <h2 className="text-5xl font-bold tracking-tighter leading-none">
                    Mark Your <span className="text-orange-500">Attendance</span>
                  </h2>
                  <p className="text-zinc-400 text-lg max-w-md">
                    Position your face in front of the camera to automatically log your attendance.
                  </p>
                </div>

                <div className="relative aspect-[4/3] md:aspect-video bg-zinc-900 rounded-3xl overflow-hidden border border-zinc-800 shadow-2xl">
                  {cameraError ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-zinc-950/80 backdrop-blur-sm z-10">
                      <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
                      <p className="text-red-400 font-medium mb-4">{cameraError}</p>
                      <button 
                        onClick={startCamera}
                        className="px-6 py-2 bg-white text-black rounded-xl font-bold hover:bg-orange-500 transition-all"
                      >
                        Try Again
                      </button>
                    </div>
                  ) : (
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  )}
                  <div className="absolute inset-0 border-[10px] md:border-[20px] border-black/20 pointer-events-none" />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-48 h-48 md:w-64 md:h-64 border-2 border-dashed border-orange-500/50 rounded-full animate-pulse" />
                  </div>
                  
                  {scanResult && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={`absolute inset-x-0 bottom-8 mx-auto w-max px-6 py-3 rounded-2xl flex items-center gap-3 backdrop-blur-md border ${
                        scanResult.success 
                          ? 'bg-green-500/20 border-green-500/50 text-green-400' 
                          : 'bg-red-500/20 border-red-500/50 text-red-400'
                      }`}
                    >
                      {scanResult.success ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                      <span className="font-medium">{scanResult.message}</span>
                    </motion.div>
                  )}
                </div>

                <button
                  onClick={handleAttendance}
                  disabled={isScanning || users.length === 0}
                  className="w-full py-6 bg-white text-black rounded-3xl font-bold text-xl hover:bg-orange-500 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                >
                  {isScanning ? (
                    <>
                      <Loader2 className="w-6 h-6 animate-spin" />
                      Scanning...
                    </>
                  ) : (
                    <>
                      <Camera className="w-6 h-6" />
                      Scan Face
                    </>
                  )}
                </button>
                {users.length === 0 && (
                  <p className="text-center text-zinc-500 text-sm">No users registered yet. Please register first.</p>
                )}
              </div>

              <div className="hidden lg:block space-y-6">
                <h3 className="text-zinc-500 uppercase tracking-widest text-xs font-bold">Recent Activity</h3>
                <div className="space-y-4">
                  {attendance.slice(0, 5).map((record) => (
                    <div key={record.id} className="bg-zinc-900/50 border border-zinc-800 p-4 rounded-2xl flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-zinc-800 rounded-full flex items-center justify-center text-orange-500 font-bold">
                          {record.userName[0]}
                        </div>
                        <div>
                          <p className="font-medium">{record.userName}</p>
                          <p className="text-xs text-zinc-500">{format(new Date(record.timestamp), 'hh:mm a')}</p>
                        </div>
                      </div>
                      <span className="text-[10px] px-2 py-1 bg-green-500/10 text-green-500 rounded-full border border-green-500/20 uppercase font-bold tracking-wider">
                        Present
                      </span>
                    </div>
                  ))}
                  {attendance.length === 0 && (
                    <div className="text-center py-12 border-2 border-dashed border-zinc-800 rounded-3xl text-zinc-600">
                      No recent activity
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'register' && (
            <motion.div
              key="register"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="max-w-2xl mx-auto space-y-12"
            >
              <div className="text-center space-y-4">
                <h2 className="text-5xl font-bold tracking-tighter">New <span className="text-orange-500">Registration</span></h2>
                <p className="text-zinc-400">Add a new user to the system by capturing their face.</p>
              </div>

              <div className="space-y-6">
                <div className="relative aspect-[4/3] md:aspect-video bg-zinc-900 rounded-3xl overflow-hidden border border-zinc-800">
                  {cameraError ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-zinc-950/80 backdrop-blur-sm z-10">
                      <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
                      <p className="text-red-400 font-medium mb-4">{cameraError}</p>
                      <button 
                        onClick={startCamera}
                        className="px-6 py-2 bg-white text-black rounded-xl font-bold hover:bg-orange-500 transition-all"
                      >
                        Try Again
                      </button>
                    </div>
                  ) : (
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  )}
                  <div className="absolute inset-0 border-[10px] md:border-[20px] border-black/20 pointer-events-none" />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-48 h-48 md:w-64 md:h-64 border-2 border-dashed border-orange-500/50 rounded-full animate-pulse" />
                  </div>
                </div>

                <div className="space-y-4">
                  <input
                    type="text"
                    placeholder="Enter Full Name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl px-6 py-4 text-lg focus:outline-none focus:border-orange-500 transition-colors"
                  />
                  <button
                    onClick={handleRegister}
                    disabled={!newName || isRegistering}
                    className="w-full py-6 bg-orange-500 text-black rounded-3xl font-bold text-xl hover:bg-white transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-3"
                  >
                    {isRegistering ? (
                      <>
                        <Loader2 className="w-6 h-6 animate-spin" />
                        Registering...
                      </>
                    ) : (
                      <>
                        <UserPlus className="w-6 h-6" />
                        Complete Registration
                      </>
                    )}
                  </button>
                </div>
              </div>

              {scanResult && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`p-4 rounded-2xl flex items-center gap-3 ${
                    scanResult.success ? 'bg-green-500/10 text-green-500 border border-green-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'
                  }`}
                >
                  {scanResult.success ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                  <span>{scanResult.message}</span>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              className="space-y-8"
            >
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div className="space-y-2">
                  <h2 className="text-4xl font-bold tracking-tighter">Attendance <span className="text-orange-500">Logs</span></h2>
                  <p className="text-zinc-500">Detailed history of all attendance scans.</p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <button 
                    onClick={exportToCSV}
                    className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-black rounded-xl text-xs font-bold uppercase tracking-widest transition-all shadow-lg shadow-orange-500/20"
                  >
                    <Download className="w-4 h-4" />
                    Export CSV
                  </button>
                  <div className="flex items-center gap-4 bg-zinc-900/50 p-1 rounded-2xl border border-zinc-800">
                    <button 
                      onClick={() => setHistoryView('logs')}
                      className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${historyView === 'logs' ? 'bg-white text-black' : 'text-zinc-500 hover:text-white'}`}
                    >
                      All Logs
                    </button>
                    <button 
                      onClick={() => setHistoryView('summary')}
                      className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${historyView === 'summary' ? 'bg-white text-black' : 'text-zinc-500 hover:text-white'}`}
                    >
                      Daily Summary
                    </button>
                  </div>
                </div>
              </div>

              {historyView === 'logs' ? (
                <div className="space-y-6">
                  <div className="flex justify-end">
                    <button 
                      onClick={() => setAttendance([])}
                      className="text-xs text-zinc-600 hover:text-red-500 transition-colors uppercase tracking-widest font-bold"
                    >
                      Clear All Logs
                    </button>
                  </div>
                  <div className="bg-zinc-900/30 border border-zinc-800 rounded-3xl overflow-hidden">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-zinc-800 bg-zinc-900/50">
                          <th className="px-6 py-4 text-xs font-bold text-zinc-500 uppercase tracking-widest">User</th>
                          <th className="px-6 py-4 text-xs font-bold text-zinc-500 uppercase tracking-widest">Date</th>
                          <th className="px-6 py-4 text-xs font-bold text-zinc-500 uppercase tracking-widest">Time</th>
                          <th className="px-6 py-4 text-xs font-bold text-zinc-500 uppercase tracking-widest">Match</th>
                          <th className="px-6 py-4 text-xs font-bold text-zinc-500 uppercase tracking-widest text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/50">
                        {attendance.map((record) => (
                          <tr key={record.id} className="hover:bg-zinc-800/20 transition-colors">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 bg-zinc-800 rounded-full flex items-center justify-center text-[10px] font-bold">
                                  {record.userName[0]}
                                </div>
                                <span className="font-medium">{record.userName}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-zinc-400">
                              {format(new Date(record.timestamp), 'MMM dd, yyyy')}
                            </td>
                            <td className="px-6 py-4 text-zinc-400">
                              {format(new Date(record.timestamp), 'hh:mm:ss a')}
                            </td>
                            <td className="px-6 py-4">
                              {record.confidence ? (
                                <span className={`text-[10px] font-mono ${record.confidence > 80 ? 'text-green-500' : record.confidence > 60 ? 'text-orange-500' : 'text-red-500'}`}>
                                  {record.confidence}%
                                </span>
                              ) : (
                                <span className="text-[10px] text-zinc-600">-</span>
                              )}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className={`text-[10px] px-2 py-1 rounded-full border uppercase font-bold tracking-wider ${
                                record.status === 'present' 
                                  ? 'bg-green-500/10 text-green-500 border-green-500/20' 
                                  : 'bg-red-500/10 text-red-500 border-red-500/20'
                              }`}>
                                {record.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {attendance.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-6 py-24 text-center text-zinc-600">
                              No attendance records found.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex justify-between items-center">
                    <h3 className="text-zinc-500 uppercase tracking-widest text-xs font-bold">Status for Today ({format(new Date(), 'MMM dd')})</h3>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => setIsAbsenceDialogOpen(true)}
                        className="px-4 py-2 bg-zinc-800 hover:bg-orange-500/20 hover:text-orange-500 text-zinc-400 rounded-xl text-xs font-bold uppercase tracking-widest border border-zinc-700 transition-all"
                      >
                        Mark User Absent
                      </button>
                      <button 
                        onClick={markAbsents}
                        className="px-4 py-2 bg-zinc-800 hover:bg-red-500/20 hover:text-red-500 text-zinc-400 rounded-xl text-xs font-bold uppercase tracking-widest border border-zinc-700 transition-all"
                      >
                        Mark Unscanned as Absent
                      </button>
                    </div>
                  </div>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {getDailySummary().map((user) => (
                      <div key={user.id} className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-3xl flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-zinc-800 rounded-2xl flex items-center justify-center text-orange-500 font-bold text-xl">
                            {user.name[0]}
                          </div>
                          <div>
                            <p className="font-bold">{user.name}</p>
                            <p className="text-xs text-zinc-500">Registered {format(new Date(user.createdAt), 'MMM dd')}</p>
                          </div>
                        </div>
                        <span className={`text-[10px] px-2 py-1 rounded-full border uppercase font-bold tracking-wider ${
                          user.status === 'present' 
                            ? 'bg-green-500/10 text-green-500 border-green-500/20' 
                            : user.status === 'absent'
                            ? 'bg-red-500/10 text-red-500 border-red-500/20'
                            : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'
                        }`}>
                          {user.status}
                        </span>
                      </div>
                    ))}
                    {users.length === 0 && (
                      <div className="col-span-full py-24 text-center text-zinc-600 border-2 border-dashed border-zinc-800 rounded-3xl">
                        No users registered to show summary.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Manual Absence Dialog */}
      <AnimatePresence>
        {isAbsenceDialogOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAbsenceDialogOpen(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-8 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 bg-orange-500/10 rounded-full flex items-center justify-center">
                  <AlertCircle className="text-orange-500 w-6 h-6" />
                </div>
                <h3 className="text-xl font-bold">Mark Manual Absence</h3>
              </div>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Select User</label>
                  <select 
                    value={selectedUserForAbsence}
                    onChange={(e) => setSelectedUserForAbsence(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-orange-500 transition-colors"
                  >
                    <option value="">Choose a user...</option>
                    {users.map(user => (
                      <option key={user.id} value={user.id}>{user.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsAbsenceDialogOpen(false)}
                    className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-bold transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => markSingleUserAbsent(selectedUserForAbsence)}
                    disabled={!selectedUserForAbsence}
                    className="flex-1 py-3 bg-orange-500 hover:bg-orange-600 text-black rounded-xl font-bold transition-all disabled:opacity-50"
                  >
                    Confirm Absence
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto p-12 border-t border-zinc-800/50 mt-12 flex flex-col md:flex-row justify-between items-center gap-6 text-zinc-600 text-sm">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4" />
          <span>FaceTrack v1.0.0</span>
        </div>
        <div className="flex gap-8">
          <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
          <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
          <a href="#" className="hover:text-white transition-colors">Support</a>
        </div>
        <p>© 2026 FaceTrack AI. All rights reserved.</p>
      </footer>
    </div>
  );
}
