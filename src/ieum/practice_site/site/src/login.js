const form = document.getElementById('login-form');
const status = document.getElementById('login-status');
form.addEventListener('submit', (e) => {
    e.preventDefault();
    // 가상 화면: 어떤 값도 저장·전송하지 않는다.
    document.getElementById('loginPassword').value = '';
    status.hidden = false;
    status.textContent = '가상 인증 화면입니다. 실제 인증은 이루어지지 않았습니다.';
});
export {};
