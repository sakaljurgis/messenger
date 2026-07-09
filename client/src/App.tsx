import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import RequireAuth from './components/RequireAuth';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import UsersPage from './pages/UsersPage';
import ChatListPage from './pages/ChatListPage';
import ChatPage from './pages/ChatPage';
import NewGroupPage from './pages/NewGroupPage';
import SettingsPage from './pages/SettingsPage';
import BotsPage from './pages/BotsPage';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route element={<RequireAuth />}>
            {/* Bottom-tab shell for the list-style screens. */}
            <Route element={<AppLayout />}>
              <Route path="/" element={<Navigate to="/chats" replace />} />
              <Route path="/chats" element={<ChatListPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/bots" element={<BotsPage />} />
            </Route>
            {/* Full-screen screens (own header, no bottom tabs), Messenger-style. */}
            <Route path="/chats/new-group" element={<NewGroupPage />} />
            <Route path="/chats/:id" element={<ChatPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
