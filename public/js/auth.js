// Toast notification system
function showToast(message, type = 'error') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Redirect if already logged in
if (localStorage.getItem('chat_token')) {
  window.location.href = '/chat';
}

// Tab switching
const tabs = document.querySelectorAll('.auth-tab');
const forms = document.querySelectorAll('.auth-form');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    forms.forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Form').classList.add('active');
  });
});

// Avatar preview
const avatarFile = document.getElementById('avatarFile');
const avatarPreview = document.getElementById('avatarPreview');

avatarFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    if (file.size > 5242880) {
      showToast('Image must be under 5MB');
      avatarFile.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      avatarPreview.innerHTML = `<img src="${ev.target.result}" alt="Avatar">`;
    };
    reader.readAsDataURL(file);
  }
});

// Login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: document.getElementById('loginInput').value.trim(),
        password: document.getElementById('loginPassword').value
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    localStorage.setItem('chat_token', data.token);
    localStorage.setItem('chat_user', JSON.stringify(data.user));
    window.location.href = '/chat';
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});

// Register
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('registerBtn');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('username', document.getElementById('regUsername').value.trim());
    formData.append('email', document.getElementById('regEmail').value.trim());
    formData.append('password', document.getElementById('regPassword').value);
    formData.append('display_name', document.getElementById('regDisplayName').value.trim());

    const avatarInput = document.getElementById('avatarFile');
    if (avatarInput.files[0]) {
      formData.append('avatar', avatarInput.files[0]);
    }

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');

    localStorage.setItem('chat_token', data.token);
    localStorage.setItem('chat_user', JSON.stringify(data.user));
    window.location.href = '/chat';
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});
