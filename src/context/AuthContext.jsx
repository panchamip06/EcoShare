import { useState, useEffect, createContext, useContext } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';

const AuthContext = createContext();

// Sanitize API URL: Remove trailing slash if present, then ensure it ends with /api
const getApiUrl = () => {
    let url = import.meta.env.VITE_API_URL || 'https://ecoshare-api.onrender.com/api';
    url = url.replace(/\/$/, ''); // Remove trailing slash
    if (!url.endsWith('/api')) url += '/api';
    return url;
};
export const API_URL = getApiUrl();

console.log('🚀 EcoShare API initialized at:', API_URL);

export const AuthProvider = ({ children }) => {
    const { user: clerkUser, isLoaded } = useUser();
    const { signOut } = useClerk();
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const sync = async () => {
            if (isLoaded) {
                if (clerkUser) {
                    await syncWithBackend(clerkUser);
                } else {
                    setUser(null);
                    setLoading(false);
                }
            }
        };
        sync();
    }, [clerkUser, isLoaded]);

    const syncWithBackend = async (clerkUser) => {
        try {
            const res = await fetch(`${API_URL}/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: clerkUser.fullName || clerkUser.username || clerkUser.primaryEmailAddress.emailAddress.split('@')[0],
                    email: clerkUser.primaryEmailAddress.emailAddress,
                    photoUrl: clerkUser.imageUrl,
                }),
            });
            const data = await res.json();
            if (res.ok) {
                setUser(data);
            }
        } catch (e) {
            console.error('Error syncing with backend:', e);
        } finally {
            setLoading(false);
        }
    };

    const login = async (email, password) => {
        // Note: For a full migration, this should use Clerk's useSignIn
        // For now, keeping it as is to not break traditional login if still used
        try {
            const res = await fetch(`${API_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (res.ok) {
                setUser(data);
                return true;
            }
        } catch (e) {
            console.error(e);
            return false;
        }
        return false;
    };

    const signup = async (name, email, password) => {
        // Note: For a full migration, this should use Clerk's useSignUp
        try {
            const res = await fetch(`${API_URL}/auth/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password }),
            });
            const data = await res.json();
            if (res.ok) {
                setUser(data);
                return true;
            }
        } catch (e) { console.error(e); }
        return false;
    };

    const logout = async () => {
        if (clerkUser) {
            await signOut();
        }
        setUser(null);
    };

    const refreshUser = async () => {
        if (!user?.id) return;
        try {
            const res = await fetch(`${API_URL}/users/${user.id}`);
            if (res.ok) {
                const updatedUser = await res.json();
                setUser(updatedUser);
            }
        } catch (e) {
            console.error('Failed to refresh user:', e);
        }
    };

    return (
        <AuthContext.Provider value={{ user, login, signup, logout, refreshUser, isLoaded: isLoaded && !loading }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
