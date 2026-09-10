import React, { useEffect, useState, useCallback } from 'react';
import { api } from './lib/api.js';
import { Badge, Dot, useToast } from './lib/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Approvals from './pages/Approvals.jsx';
import Projects from './pages/Projects.jsx';
import Workspace from './pages/Workspace.jsx';
import Registry from './pages/Registry.jsx';
import Settings from './pages/Settings.jsx';

/** Hash routing, so every screen is linkable and a refresh keeps you where you were. */
function useRoute() {
  const [hash, setHash] = useState(window.location.hash.slice(1) || '/projects');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash.slice(1) || '/projects');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((path) => {
    window.location.hash = path;
  }, []);
  return [hash, navigate];
}

export default function App() {
  const [route, navigate] = useRoute();
  const [projects, setProjects] = useState([]);
  const [health, setHealth] = useState(null);
  const [approvals, setApprovals] = useState({ total: 0, blocking: 0, byProject: {} });
  const toast = useToast();

  /**
   * Polled globally rather than per-screen: a run waiting on a human is waiting no matter which
   * page you happen to be on, so the count has to follow you.
   */
  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals(await api.approvals());
    } catch {
      /* the sidebar badge is not worth a toast */
    }
  }, []);

  useEffect(() => {
    refreshApprovals();
    const timer = setInterval(refreshApprovals, 5000);
    return () => clearInterval(timer);
  }, [refreshApprovals, route]);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.projects());
    } catch (err) {
      toast(`Cannot reach the API: ${err.message}`, 'err');
    }
  }, [toast]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
    refreshHealth();
  }, [refreshProjects, refreshHealth]);

  const [, section, projectId, tab] = route.split('/');
  const activeProject = projects.find((p) => p.id === projectId);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AS</div>
          <div>
            <div className="brand-name">ASDD</div>
            <div className="brand-sub">Control plane</div>
          </div>
        </div>

        <div className="nav-label">Workspace</div>
        <div className={`nav-item ${section === 'dashboard' ? 'active' : ''}`} onClick={() => navigate('/dashboard')}>
          <span className="ico">◱</span> Dashboard
        </div>
        <div className={`nav-item ${section === 'approvals' ? 'active' : ''}`} onClick={() => navigate('/approvals')}>
          <span className="ico">✋</span> Approvals
          {approvals.total > 0 && (
            <span className="nav-count" style={{ color: approvals.blocking ? 'var(--fail)' : 'var(--warn)', fontWeight: 700 }}>
              {approvals.total}
            </span>
          )}
        </div>
        <div className={`nav-item ${section === 'projects' && !projectId ? 'active' : ''}`} onClick={() => navigate('/projects')}>
          <span className="ico">▤</span> Projects
          <span className="nav-count">{projects.length}</span>
        </div>
        <div className={`nav-item ${section === 'registry' ? 'active' : ''}`} onClick={() => navigate('/registry')}>
          <span className="ico">⬡</span> Registries
        </div>
        <div className={`nav-item ${section === 'settings' ? 'active' : ''}`} onClick={() => navigate('/settings')}>
          <span className="ico">⚙</span> Settings
        </div>

        {projects.length > 0 && <div className="nav-label">Recent projects</div>}
        {projects.slice(0, 8).map((project) => (
          <div
            key={project.id}
            className={`nav-item ${projectId === project.id ? 'active' : ''}`}
            onClick={() => navigate(`/projects/${project.id}`)}
            title={`${project.source || '?'} → ${project.target || '?'}`}
          >
            <span className="ico">
              <Dot tone={approvals.byProject[project.id] ? 'warn' : project.stage === 'run' ? 'pass' : ''} pulse={Boolean(approvals.byProject[project.id])} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
            {approvals.byProject[project.id] > 0 && <span className="nav-count" style={{ color: 'var(--warn)' }}>{approvals.byProject[project.id]}</span>}
          </div>
        ))}

        <div className="sidebar-foot">
          <div className="tiny faint" style={{ marginBottom: 6 }}>Engine</div>
          {health ? (
            <Badge tone={health.llm.mode === 'llm' ? 'accent' : health.llm.mode === 'offline' ? '' : 'info'}>
              {health.llm.mode === 'llm' ? (health.llm.provider === 'editor' ? 'Copilot via MCP' : 'Anthropic model') : health.llm.mode === 'offline' ? 'Offline rules' : 'Rules fallback'}
            </Badge>
          ) : (
            <Badge tone="fail">API unreachable</Badge>
          )}
          <div className="tiny faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
            {health?.llm?.detail || 'Start the server with npm run dev.'}
          </div>
        </div>
      </aside>

      <main className="main">
        {section === 'dashboard' && <Dashboard navigate={navigate} />}
        {section === 'approvals' && <Approvals navigate={navigate} />}
        {section === 'projects' && !projectId && (
          <Projects projects={projects} onChanged={refreshProjects} navigate={navigate} />
        )}
        {section === 'projects' && projectId && (
          <Workspace
            key={projectId}
            projectId={projectId}
            tab={tab || 'spec'}
            navigate={navigate}
            onChanged={refreshProjects}
            projectName={activeProject?.name}
            pendingApprovals={approvals.items?.filter((item) => item.projectId === projectId) || []}
          />
        )}
        {section === 'registry' && <Registry />}
        {section === 'settings' && <Settings onSaved={refreshHealth} />}
      </main>
    </div>
  );
}
