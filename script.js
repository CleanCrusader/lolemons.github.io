// Enhanced Lemon Website Interactions
document.addEventListener('DOMContentLoaded', function() {
    
    // Smooth scrolling for navigation links
    function initSmoothScrolling() {
        const links = document.querySelectorAll('a[href^="#"]');
        
        links.forEach(link => {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                
                const targetId = this.getAttribute('href');
                const targetSection = document.querySelector(targetId);
                
                if (targetSection) {
                    const headerOffset = 80;
                    const elementPosition = targetSection.offsetTop;
                    const offsetPosition = elementPosition - headerOffset;
                    
                    window.scrollTo({
                        top: offsetPosition,
                        behavior: 'smooth'
                    });
                }
            });
        });
    }
    
    // Header scroll effect
    function initHeaderScrollEffect() {
        const header = document.querySelector('.header');
        let lastScrollY = window.scrollY;
        
        function updateHeader() {
            const scrollY = window.scrollY;
            
            if (scrollY > 100) {
                header.style.background = 'rgba(255, 254, 247, 0.98)';
                header.style.boxShadow = '0 2px 20px rgba(0,0,0,0.1)';
            } else {
                header.style.background = 'rgba(255, 254, 247, 0.95)';
                header.style.boxShadow = 'none';
            }
            
            // Hide header on scroll down, show on scroll up
            if (scrollY > lastScrollY && scrollY > 200) {
                header.style.transform = 'translateY(-100%)';
            } else {
                header.style.transform = 'translateY(0)';
            }
            
            lastScrollY = scrollY;
        }
        
        window.addEventListener('scroll', updateHeader);
    }
    
    // Intersection Observer for animations
    function initScrollAnimations() {
        const observerOptions = {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px'
        };
        
        const observer = new IntersectionObserver(function(entries) {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('animate-in');
                    
                    // Special handling for stats counter
                    if (entry.target.classList.contains('hero-stats')) {
                        animateStats();
                    }
                    
                    // Special handling for product cards
                    if (entry.target.classList.contains('products-grid')) {
                        animateProductCards();
                    }
                }
            });
        }, observerOptions);
        
        // Observe elements for animation
        const animateElements = document.querySelectorAll('.solution-card, .product-card, .testimonial-card, .science-content, .hero-stats, .products-grid');
        animateElements.forEach(el => {
            observer.observe(el);
        });
    }
    
    // Animate statistics counters
    function animateStats() {
        const stats = document.querySelectorAll('.stat-number');
        
        stats.forEach(stat => {
            const finalText = stat.textContent;
            const isNumber = /^\d+\.?\d*$/.test(finalText.replace('%', ''));
            
            if (isNumber) {
                const finalValue = parseFloat(finalText.replace('%', ''));
                const duration = 2000;
                const startTime = Date.now();
                
                function updateNumber() {
                    const elapsed = Date.now() - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    
                    // Easing function
                    const easedProgress = 1 - Math.pow(1 - progress, 3);
                    
                    const currentValue = finalValue * easedProgress;
                    const displayValue = finalText.includes('%') ? 
                        currentValue.toFixed(1) + '%' : 
                        currentValue.toFixed(1);
                    
                    stat.textContent = displayValue;
                    
                    if (progress < 1) {
                        requestAnimationFrame(updateNumber);
                    } else {
                        stat.textContent = finalText;
                    }
                }
                
                stat.textContent = '0';
                requestAnimationFrame(updateNumber);
            }
        });
    }
    
    // Animate product cards with stagger effect
    function animateProductCards() {
        const cards = document.querySelectorAll('.product-card');
        
        cards.forEach((card, index) => {
            setTimeout(() => {
                card.style.animation = `fadeInUp 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55) both`;
            }, index * 200);
        });
    }
    
    // Enhanced hover effects for product cards
    function initProductCardEffects() {
        const productCards = document.querySelectorAll('.product-card');
        
        productCards.forEach(card => {
            const image = card.querySelector('.product-image');
            
            card.addEventListener('mouseenter', function() {
                if (image) {
                    image.style.transform = 'scale(1.05)';
                    image.style.transition = 'transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
                }
            });
            
            card.addEventListener('mouseleave', function() {
                if (image) {
                    image.style.transform = 'scale(1)';
                }
            });
        });
    }
    
    // Lemon slice animation controller
    function initLemonAnimation() {
        const lemonSlices = document.querySelectorAll('.lemon-slice');
        let isHovered = false;
        
        lemonSlices.forEach((slice, index) => {
            slice.addEventListener('mouseenter', function() {
                if (!isHovered) {
                    isHovered = true;
                    
                    lemonSlices.forEach((s, i) => {
                        s.style.animationPlayState = 'paused';
                        s.style.transform = `scale(1.1) rotate(${i * 120}deg)`;
                        s.style.transition = 'transform 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
                    });
                }
            });
            
            slice.addEventListener('mouseleave', function() {
                setTimeout(() => {
                    isHovered = false;
                    lemonSlices.forEach((s, i) => {
                        s.style.animationPlayState = 'running';
                        s.style.transform = 'scale(1) rotate(0deg)';
                    });
                }, 100);
            });
        });
    }
    
    // Molecular diagram animation
    function initMolecularAnimation() {
        const atoms = document.querySelectorAll('.atom');
        
        atoms.forEach((atom, index) => {
            atom.style.animation = `pulse 2s ease-in-out infinite ${index * 0.3}s`;
        });
        
        // Add click interaction to trigger transformation
        const diagram = document.querySelector('.molecular-diagram');
        if (diagram) {
            diagram.addEventListener('click', function() {
                atoms.forEach(atom => {
                    atom.style.animation = 'none';
                    atom.style.transform = 'scale(1.2)';
                    atom.style.transition = 'transform 0.3s ease';
                    
                    setTimeout(() => {
                        atom.style.transform = 'scale(1)';
                        setTimeout(() => {
                            atom.style.animation = `pulse 2s ease-in-out infinite ${Math.random() * 2}s`;
                        }, 300);
                    }, 300);
                });
            });
        }
    }
    
    // Form validation and enhancement (for future contact forms)
    function initFormEnhancements() {
        const forms = document.querySelectorAll('form');
        
        forms.forEach(form => {
            const inputs = form.querySelectorAll('input, textarea, select');
            
            inputs.forEach(input => {
                // Add floating label effect
                input.addEventListener('focus', function() {
                    this.parentElement.classList.add('focused');
                });
                
                input.addEventListener('blur', function() {
                    if (!this.value) {
                        this.parentElement.classList.remove('focused');
                    }
                });
                
                // Real-time validation
                input.addEventListener('input', function() {
                    validateField(this);
                });
            });
        });
    }
    
    function validateField(field) {
        const value = field.value.trim();
        const fieldType = field.type;
        let isValid = true;
        
        switch (fieldType) {
            case 'email':
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                isValid = emailRegex.test(value);
                break;
            case 'tel':
                const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
                isValid = phoneRegex.test(value.replace(/\s/g, ''));
                break;
            default:
                isValid = value.length > 0;
        }
        
        field.parentElement.classList.toggle('valid', isValid);
        field.parentElement.classList.toggle('invalid', !isValid && value.length > 0);
        
        return isValid;
    }
    
    // Parallax effect for hero section
    function initParallaxEffect() {
        const hero = document.querySelector('.hero');
        const lemonAnimation = document.querySelector('.lemon-animation');
        
        if (hero && lemonAnimation) {
            window.addEventListener('scroll', function() {
                const scrolled = window.pageYOffset;
                const heroHeight = hero.offsetHeight;
                const scrollProgress = scrolled / heroHeight;
                
                if (scrollProgress < 1) {
                    lemonAnimation.style.transform = `translateY(${scrolled * 0.3}px) scale(${1 + scrollProgress * 0.1})`;
                    lemonAnimation.style.opacity = 1 - scrollProgress * 0.5;
                }
            });
        }
    }
    
    // Enhanced button interactions
    function initButtonEffects() {
        const buttons = document.querySelectorAll('.btn-primary, .btn-secondary, .btn-product');
        
        buttons.forEach(button => {
            button.addEventListener('click', function(e) {
                // Ripple effect
                const rect = this.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height);
                const x = e.clientX - rect.left - size / 2;
                const y = e.clientY - rect.top - size / 2;
                
                const ripple = document.createElement('span');
                ripple.className = 'ripple';
                ripple.style.cssText = `
                    position: absolute;
                    width: ${size}px;
                    height: ${size}px;
                    left: ${x}px;
                    top: ${y}px;
                    background: rgba(255,255,255,0.3);
                    border-radius: 50%;
                    transform: scale(0);
                    animation: ripple 0.6s linear;
                    pointer-events: none;
                `;
                
                this.style.position = 'relative';
                this.style.overflow = 'hidden';
                this.appendChild(ripple);
                
                setTimeout(() => {
                    ripple.remove();
                }, 600);
            });
        });
        
        // Add ripple animation to CSS
        if (!document.querySelector('#ripple-style')) {
            const style = document.createElement('style');
            style.id = 'ripple-style';
            style.textContent = `
                @keyframes ripple {
                    to {
                        transform: scale(4);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }
    }
    
    // Lazy loading for images
    function initLazyLoading() {
        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.classList.remove('lazy');
                        imageObserver.unobserve(img);
                    }
                });
            });
            
            const lazyImages = document.querySelectorAll('img[data-src]');
            lazyImages.forEach(img => imageObserver.observe(img));
        }
    }
    
    // Performance optimization: throttle scroll events
    function throttle(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    // Initialize all functionality
    function init() {
        initSmoothScrolling();
        initHeaderScrollEffect();
        initScrollAnimations();
        initProductCardEffects();
        initLemonAnimation();
        initMolecularAnimation();
        initFormEnhancements();
        initParallaxEffect();
        initButtonEffects();
        initLazyLoading();
        
        // Add loaded class to body for CSS transitions
        setTimeout(() => {
            document.body.classList.add('loaded');
        }, 100);
        
        console.log('🍋 Lots of Lemon website enhanced and ready!');
    }
    
    // Run initialization
    init();
    
    // Expose some functions globally for debugging
    window.LemonWebsite = {
        animateStats,
        animateProductCards,
        validateField
    };
});

// Service Worker registration for PWA features (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js')
            .then(function(registration) {
                console.log('SW registered: ', registration);
            })
            .catch(function(registrationError) {
                console.log('SW registration failed: ', registrationError);
            });
    });
}
