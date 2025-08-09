import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function LoginPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const onSubmit = async () => {
    setError(null);
    if (pin.length < 4) {
      setError('Enter 4-6 digits');
      return;
    }
    try {
      const user = await window.api.auth.loginWithPin(pin);
      if (user) navigate('/app');
      else setError('Invalid PIN');
    } catch (e) {
      console.error(e);
      setError('Login failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm">
        <h1 className="text-xl font-semibold mb-4 text-center">Enter PIN</h1>
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
          className="w-full p-3 rounded bg-gray-700 focus:outline-none"
        />
        <button onClick={onSubmit} className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 py-2 rounded">Login</button>
        {error && <div className="text-red-400 mt-2 text-sm">{error}</div>}
      </div>
    </div>
  );
}


