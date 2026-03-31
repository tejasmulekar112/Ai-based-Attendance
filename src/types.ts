export interface User {
  id: string;
  name: string;
  descriptor: number[]; // Serialized face descriptor
  photoUrl?: string;
  createdAt: string;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  userName: string;
  timestamp: string;
  status: 'present' | 'absent';
}
