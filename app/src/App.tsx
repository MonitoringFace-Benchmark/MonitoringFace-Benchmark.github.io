import { Link, Route, Routes } from 'react-router-dom';
import GridPage from './pages/GridPage';
import ExperimentPage from './pages/ExperimentPage';
import SuitePage from './pages/SuitePage';

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
          <Route path="/s/:id" element={<SuitePage />} />
        </Routes>
      </main>
    </div>
  );
}
