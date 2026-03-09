/**
 * toast.js — Sistema de notificações in-app do Lyncro
 * Substitui alert() nativo por toasts estilizados com identidade visual Lyncro.
 * Uso: lyncroToast.error('msg') | .warning() | .info() | .success()
 */
(function () {
    'use strict';

    const TYPES = {
        error:   { icon: 'ph-x-circle',     color: '#ef4444', border: 'rgba(239,68,68,0.35)'  },
        warning: { icon: 'ph-warning',       color: '#f59e0b', border: 'rgba(245,158,11,0.35)' },
        info:    { icon: 'ph-info',          color: '#0078d4', border: 'rgba(0,120,212,0.35)'  },
        success: { icon: 'ph-check-circle',  color: '#10b981', border: 'rgba(16,185,129,0.35)' },
    };

    function getContainer() {
        let c = document.getElementById('lt-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'lt-container';
            Object.assign(c.style, {
                position:      'fixed',
                top:           '20px',
                right:         '20px',
                zIndex:        '999999',
                display:       'flex',
                flexDirection: 'column',
                gap:           '10px',
                pointerEvents: 'none',
                maxWidth:      '400px',
                width:         'calc(100vw - 40px)',
            });
            document.body.appendChild(c);
        }
        return c;
    }

    function dismiss(toast) {
        clearTimeout(toast._lt);
        toast.style.transform = 'translateX(calc(100% + 28px))';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 320);
    }

    function show(message, type, duration) {
        type = type || 'error';
        duration = duration == null ? 5500 : duration;
        const cfg = TYPES[type] || TYPES.error;

        const toast = document.createElement('div');
        Object.assign(toast.style, {
            background:         'rgba(10,10,22,0.97)',
            backdropFilter:     'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border:             `1px solid ${cfg.border}`,
            borderLeft:         `3px solid ${cfg.color}`,
            borderRadius:       '12px',
            padding:            '13px 14px 13px 16px',
            color:              '#e2e8f0',
            fontFamily:         'Inter, system-ui, sans-serif',
            fontSize:           '13px',
            fontWeight:         '500',
            lineHeight:         '1.45',
            pointerEvents:      'auto',
            display:            'flex',
            alignItems:         'flex-start',
            gap:                '10px',
            boxShadow:          '0 8px 40px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)',
            cursor:             'pointer',
            transform:          'translateX(calc(100% + 28px))',
            transition:         'transform 0.38s cubic-bezier(0.16,1,0.3,1), opacity 0.28s ease',
            userSelect:         'none',
        });

        toast.innerHTML = `
            <i class="ph ${cfg.icon}" style="font-size:17px;color:${cfg.color};flex-shrink:0;margin-top:1px"></i>
            <span style="flex:1;min-width:0">${message}</span>
            <i class="ph ph-x" style="font-size:13px;color:rgba(255,255,255,0.35);flex-shrink:0;margin-top:2px"></i>
        `;

        toast.addEventListener('click', () => dismiss(toast));
        getContainer().appendChild(toast);

        // Slide in
        requestAnimationFrame(() => requestAnimationFrame(() => {
            toast.style.transform = 'translateX(0)';
        }));

        if (duration > 0) {
            toast._lt = setTimeout(() => dismiss(toast), duration);
        }

        return toast;
    }

    window.lyncroToast = {
        show,
        error:   (msg, d) => show(msg, 'error',   d),
        warning: (msg, d) => show(msg, 'warning', d),
        info:    (msg, d) => show(msg, 'info',    d),
        success: (msg, d) => show(msg, 'success', d),
    };
})();
