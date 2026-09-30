import { redirect } from 'next/navigation';

// "Today" was folded into the dashboard; keep old links working.
export default function TodayPage() {
  redirect('/dashboard');
}
