import { useAuth } from '../lib/auth';
import { AvatarPicker } from '../components/ui/avatar-picker';
import { useLocation } from 'wouter';
import { useState, useEffect } from 'react';
import { api } from '../lib/api';

export default function Profile() {
  const { user, logout, loading: authLoading } = useAuth();
  const [, navigate] = useLocation();

  // Attendre la fin de la vérification de session avant toute redirection
  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
  }, [authLoading, user]);

  if (authLoading) return <div className="min-h-screen" style={{ background: 'var(--surface-0)' }} />;
  if (!user) return null;

  const joined = user.createdAt ? new Date(user.createdAt * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Recently';

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface-0)' }}>
      <div className="max-w-xl mx-auto px-6 py-10">
        <h1 className="text-xl font-semibold mb-6" style={{ color: 'var(--text-secondary)' }}>Profile</h1>

        <div className="rounded-xl p-6 mb-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
          <div className="mb-6">
            <div className="mb-4">
              <div className="text-[16px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{user.name}</div>
              <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{user.email}</div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--text-ghost)' }}>Joined {joined}</div>
            </div>
            {/* Rond de profil : photo du compte (envoyée, Google ou Gravatar), modifiable ici */}
            <AvatarPicker user={user} size={56} ringColor="var(--surface-1)" />
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-[11px] font-medium mb-1.5 block" style={{ color: 'var(--text-dim)' }}>Full Name</label>
              <div className="h-10 px-3 flex items-center rounded-lg text-[13px]" style={{ background: 'var(--surface-3)', border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>{user.name}</div>
            </div>
            <div>
              <label className="text-[11px] font-medium mb-1.5 block" style={{ color: 'var(--text-dim)' }}>Email</label>
              <div className="h-10 px-3 flex items-center rounded-lg text-[13px]" style={{ background: 'var(--surface-3)', border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>{user.email}</div>
            </div>
          </div>
        </div>

        <div className="rounded-xl p-5 mb-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13px] font-medium mb-1" style={{ color: 'var(--text-dim)' }}>Current Plan</h2>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold capitalize" style={{ color: 'var(--text-secondary)' }}>{user.plan || 'Free'}</span>
                {user.plan === 'free' && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-4)', color: 'var(--text-dim)' }}>Limited</span>}
                {user.plan === 'business' && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--teal-subtle)', color: 'var(--teal)' }}>Active</span>}
                {user.plan === 'enterprise' && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: '#8B5CF633', color: '#8B5CF6' }}>Active</span>}
              </div>
            </div>
            <button onClick={() => navigate('/plans')}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
              style={{ border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-4)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              {user.plan === 'free' ? 'Upgrade' : 'Manage Plan'}
            </button>
          </div>
        </div>

        <div className="rounded-xl p-5" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
          <h2 className="text-[13px] font-medium mb-3" style={{ color: 'var(--text-dim)' }}>Account</h2>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>User ID</span>
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-ghost)' }}>{user.id?.slice(0, 12)}...</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Status</span>
              <span className="text-[11px]" style={{ color: 'var(--teal)' }}>Active</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
