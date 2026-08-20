import { Link, Route, Routes } from 'react-router-dom';
import GridPage from './pages/GridPage';
import ExperimentPage from './pages/ExperimentPage';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          MonitoringFace <span className="brand-sub">experiments</span>
        </Link>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<GridPage />} />
          <Route path="/e/:id" element={<ExperimentPage />} />
        </Routes>
      </main>
    </div>
  );
}
