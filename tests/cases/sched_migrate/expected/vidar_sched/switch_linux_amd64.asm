bits 64

extern vidar_go_start
global vidar_switch
global vidar_entry

section .note.GNU-stack
section .text

;; vidar_switch(save, to): pushes callee-saved registers, stores rsp in *save, resumes the stack at to
vidar_switch:
	push rbp
	push rbx
	push r12
	push r13
	push r14
	push r15
	mov [rdi], rsp
	mov rsp, rsi
	pop r15
	pop r14
	pop r13
	pop r12
	pop rbx
	pop rbp
	ret

;; a new goroutine's first resume lands here, with its G in r12 and rsp 16-byte aligned
vidar_entry:
	mov rdi, r12
	call vidar_go_start wrt ..plt
	ud2
