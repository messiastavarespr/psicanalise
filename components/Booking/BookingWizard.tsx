
import React, { useState, useMemo, useEffect } from 'react';
import { CLINIC_ADDRESS, CANCELLATION_POLICY, PIX_MOCK_KEY } from '../../constants';
import { Service, FormatType, Appointment, Block, ClinicalSettings, GoogleBusySlot } from '../../types';
import { GoogleCalendarService } from '../../services/googleCalendarService';
import { MercadoPagoService } from '../../services/mercadoPagoService';

interface BookingWizardProps {
  services: Service[];
  initialService: Service | null;
  appointments: Appointment[];
  blocks: Block[];
  clinicalSettings: ClinicalSettings;
  preFilledPatient?: { name: string, email: string, phone: string, format?: any } | null;
  onCancel: () => void;
  onComplete: (appointment: Appointment) => void;
}

type Step = 'service' | 'format' | 'datetime' | 'info' | 'payment';

const BookingWizard: React.FC<BookingWizardProps> = ({
  services,
  initialService,
  appointments,
  blocks,
  clinicalSettings,
  preFilledPatient,
  onCancel,
  onComplete
}) => {
  const [step, setStep] = useState<Step>(
    initialService && preFilledPatient?.format ? 'datetime' : initialService ? 'format' : 'service'
  );
  const [selectedService, setSelectedService] = useState<Service | null>(initialService);
  const [selectedFormat, setSelectedFormat] = useState<FormatType | null>(preFilledPatient?.format || null);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'mercadopago' | null>(null);
  const [patientData, setPatientData] = useState({
    name: preFilledPatient?.name || '',
    email: preFilledPatient?.email || '',
    phone: preFilledPatient?.phone || '',
    reason: '',
    agreeToLgpd: !!preFilledPatient
  });
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [mpInitPoint, setMpInitPoint] = useState<string | null>(null);
  const [googleBusySlots, setGoogleBusySlots] = useState<GoogleBusySlot[]>([]);
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);

  // Calendar Logic State
  const [viewDate, setViewDate] = useState(new Date());

  useEffect(() => {
    if (preFilledPatient) {
      setPatientData({
        ...patientData,
        name: preFilledPatient.name,
        email: preFilledPatient.email,
        phone: preFilledPatient.phone,
        agreeToLgpd: true
      });
      if (preFilledPatient.format) {
        setSelectedFormat(preFilledPatient.format);
      }
    }
  }, [preFilledPatient]);

  useEffect(() => {
    const fetchGoogleBusy = async () => {
      if (selectedDate && clinicalSettings.integrations.googleCalendarConnected && clinicalSettings.integrations.googleAccessToken) {
        setIsLoadingGoogle(true);
        try {
          const start = new Date(`${selectedDate}T00:00:00`);
          const end = new Date(`${selectedDate}T23:59:59`);

          // Use help of listEvents which is proven to work in Admin
          const events = await GoogleCalendarService.listEvents(start, end, clinicalSettings.integrations.googleAccessToken);

          // Filter out cancelled events.
          // IGNORE all-day events (start.date) to prevent blocking the whole day.
          // ALLOW "Transparent" (Free) events if they have a specific time (dateTime).
          const busySlots: GoogleBusySlot[] = events
            .filter((ev: any) =>
              ev.status !== 'cancelled' &&
              ev.start.dateTime // MUST have a specific time
            )
            .map((ev: any) => ({
              start: ev.start.dateTime,
              end: ev.end.dateTime
            }));


          setGoogleBusySlots(busySlots);
        } catch (error) {
          console.error("Falha ao sincronizar agenda externa:", error);
        } finally {
          setIsLoadingGoogle(false);
        }
      }
    };
    fetchGoogleBusy();
  }, [selectedDate, clinicalSettings.integrations]);

  const filteredAvailableSlots = useMemo(() => {
    if (!selectedDate) return [];

    const dateObj = new Date(selectedDate + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();
    const workingConfig = clinicalSettings.workingDays.find(wd => wd.day === dayOfWeek);

    if (!workingConfig || !workingConfig.isOpen) return [];

    const slots: string[] = [];
    const sessionDuration = selectedService?.duration || clinicalSettings.defaultSessionDuration;
    const buffer = 10;
    const stepSize = sessionDuration + buffer;

    const now = new Date();

    workingConfig.periods.forEach(period => {
      if (period.enabled === false) return;

      let current = new Date(`${selectedDate}T${period.start}:00`);
      const end = new Date(`${selectedDate}T${period.end}:00`);

      while (current < end) {
        const timeStr = current.toTimeString().substring(0, 5);
        const nextTime = new Date(current.getTime() + sessionDuration * 60000);

        if (current < now) {
          current.setMinutes(current.getMinutes() + stepSize);
          continue;
        }

        const hasApt = appointments.some(a => a.date === selectedDate && a.startTime === timeStr && a.status !== 'cancelled');
        const hasBlock = blocks.some(b => {
          const isWithinDate = selectedDate >= b.startDate && selectedDate <= (b.endDate || b.startDate);
          if (!isWithinDate) return false;
          if (b.isAllDay) return true;
          if (b.startTime && b.endTime) return timeStr >= b.startTime && timeStr < b.endTime;
          return false;
        });

        const isGoogleBusy = googleBusySlots.some(busy => {
          const busyStart = new Date(busy.start);
          let busyEnd = new Date(busy.end);

          // Fix for 0-duration events: treat as blocking the start time
          if (busyStart.getTime() === busyEnd.getTime()) {
            busyEnd = new Date(busyStart.getTime() + 1);
          }

          const overlaps = (current < busyEnd && nextTime > busyStart);
          if (overlaps) {
            // console.log(`[Wizard] Slot ${timeStr} conflitante com Google:`, busy);
          }
          return overlaps;
        });

        if (!hasApt && !hasBlock && !isGoogleBusy) {
          if (nextTime <= end) {
            slots.push(timeStr);
          }
        }
        current.setMinutes(current.getMinutes() + stepSize);
      }
    });

    return Array.from(new Set(slots)).sort();
  }, [selectedDate, appointments, blocks, clinicalSettings, googleBusySlots, selectedService]);

  const calendarDays = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();

    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let i = 1; i <= totalDays; i++) days.push(i);
    return days;
  }, [viewDate]);

  const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const weekDays = ["D", "S", "T", "Q", "Q", "S", "S"];

  const steps: Step[] = ['service', 'format', 'datetime', 'info', 'payment'];
  const currentIndex = steps.indexOf(step);

  const handleNext = () => {
    if (currentIndex < steps.length - 1) setStep(steps[currentIndex + 1]);
  };

  const handleBack = () => {
    if (currentIndex > 0) {
      if (step === 'payment' && mpInitPoint) {
        setMpInitPoint(null);
        setPaymentMethod(null);
      }
      setStep(steps[currentIndex - 1]);
    } else onCancel();
  };

  const prepareMercadoPago = async () => {
    setPaymentMethod('mercadopago');
    setIsProcessingPayment(true);
    try {
      const tempAppointment: Appointment = {
        id: 'temp',
        serviceId: selectedService?.id || '',
        patientName: patientData.name,
        patientEmail: patientData.email,
        patientPhone: patientData.phone,
        date: selectedDate,
        startTime: selectedTime,
        endTime: '',
        format: selectedFormat!,
        status: 'pending_payment',
        createdAt: new Date().toISOString()
      };

      const initPoint = await MercadoPagoService.createPreference(tempAppointment, selectedService!, clinicalSettings.integrations.mercadoPagoAccessToken);
      setMpInitPoint(initPoint);
    } catch (e) {
      alert("Erro ao gerar link de pagamento.");
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleFinalize = async () => {
    setIsProcessingPayment(true);
    await new Promise(r => setTimeout(r, 2000));

    const appointment: Appointment = {
      id: Math.random().toString(36).substr(2, 9),
      serviceId: selectedService?.id || '',
      patientName: patientData.name,
      patientEmail: patientData.email,
      patientPhone: patientData.phone,
      consultationReason: patientData.reason,
      date: selectedDate,
      startTime: selectedTime,
      endTime: '',
      format: selectedFormat!,
      status: 'confirmed',
      createdAt: new Date().toISOString()
    };
    onComplete(appointment);
  };

  const stepLabels: Record<Step, string> = {
    service: 'Serviço',
    format: 'Modalidade',
    datetime: 'Horário',
    info: 'Cadastro',
    payment: 'Pagamento'
  };

  return (
    <div className="max-w-5xl mx-auto pt-24 md:pt-32 pb-16 px-4 md:px-6 fade-in min-h-screen">
      <div className="mb-12 md:mb-24 flex justify-between items-center max-w-lg mx-auto relative px-2">
        <div className="absolute top-1/2 left-4 right-4 h-[1px] bg-slate-200 -translate-y-1/2 -z-10">
          <div className="h-full bg-slate-900 transition-all duration-700 ease-in-out" style={{ width: `${(currentIndex / (steps.length - 1)) * 100}%` }} />
        </div>
        {steps.map((s, i) => {
          const isCompleted = i < currentIndex;
          const isActive = i === currentIndex;
          return (
            <div key={s} className="relative flex flex-col items-center">
              <div className={`w-8 h-8 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all duration-500 z-10 ${isCompleted || isActive ? 'bg-slate-900 text-white shadow-lg' : 'bg-white border border-slate-200 text-slate-400'}`}>
                {isCompleted ? <svg className="w-4 h-4 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg> : <span className="text-[10px] md:text-sm font-bold">{i + 1}</span>}
              </div>
              <span className={`hidden md:block absolute -bottom-8 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest transition-colors duration-500 ${isActive ? 'text-slate-900' : 'text-slate-500'}`}>{stepLabels[s]}</span>
            </div>
          );
        })}
      </div>

      <div className="md:hidden text-center mb-8">
        <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">Passo {currentIndex + 1} de 5</span>
        <h2 className="text-xl font-serif font-bold text-slate-900 mt-1">{stepLabels[step]}</h2>
      </div>

      <div className="bg-white rounded-[30px] md:rounded-[70px] shadow-xl md:shadow-2xl border border-slate-100 overflow-hidden transition-all">
        <div className="p-6 md:p-20">
          {step === 'service' && (
            <div className="fade-in">
              <div className="hidden md:block text-center mb-16"><h2 className="text-5xl font-serif text-slate-900 mb-4 italic">Tipo de Atendimento</h2></div>
              <div className="grid gap-4 md:gap-6">
                {services.map(s => (
                  <button key={s.id} onClick={() => { setSelectedService(s); handleNext(); }} className={`group text-left p-6 md:p-10 rounded-[25px] md:rounded-[45px] border-2 transition-all flex flex-col md:flex-row justify-between md:items-center active:scale-[0.98] ${selectedService?.id === s.id ? 'border-slate-900 bg-slate-50' : 'border-slate-100 bg-white shadow-sm'}`}>
                    <div className="max-w-xl md:pr-6"><h3 className="text-lg md:text-2xl font-serif text-slate-900 mb-2 md:mb-3">{s.name}</h3><p className="text-sm md:text-base text-slate-700 font-light leading-relaxed">{s.description}</p></div>
                    <div className="mt-4 md:mt-0 pt-4 md:pt-0 border-t md:border-t-0 md:border-l border-slate-200 flex justify-between md:flex-col md:text-right md:pl-10">
                      <div><span className="text-[9px] md:text-[11px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Investimento</span><span className="text-xl md:text-4xl font-serif text-slate-900 block">R$ {s.price}</span></div>
                      <div className="flex items-end md:mt-2"><span className="inline-block px-3 py-1 bg-slate-900 text-white text-[9px] font-bold rounded-full uppercase tracking-tighter">{s.duration} MIN</span></div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'format' && (
            <div className="fade-in">
              <div className="grid md:grid-cols-2 gap-4 md:gap-10">
                <button onClick={() => { setSelectedFormat('online'); handleNext(); }} className="p-8 md:p-16 rounded-[30px] md:rounded-[60px] border-2 border-slate-100 active:border-slate-900 transition-all text-center group bg-white shadow-sm hover:shadow-xl">
                  <div className="w-16 h-16 md:w-24 md:h-24 bg-slate-100 rounded-[20px] md:rounded-[40px] flex items-center justify-center mx-auto mb-6 md:mb-10 transition-all"><svg className="w-8 h-8 md:w-12 md:h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></div>
                  <h3 className="text-xl md:text-3xl font-serif text-slate-900 mb-2 md:mb-4 italic">Online</h3><p className="text-sm md:text-base text-slate-700 font-light">Videochamada (WhatsApp)</p>
                </button>
                <button onClick={() => { setSelectedFormat('presencial'); handleNext(); }} className="p-8 md:p-16 rounded-[30px] md:rounded-[60px] border-2 border-slate-100 active:border-slate-900 transition-all text-center group bg-white shadow-sm hover:shadow-xl">
                  <div className="w-16 h-16 md:w-24 md:h-24 bg-slate-100 rounded-[20px] md:rounded-[40px] flex items-center justify-center mx-auto mb-6 md:mb-10 transition-all"><svg className="w-8 h-8 md:w-12 md:h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /></svg></div>
                  <h3 className="text-xl md:text-3xl font-serif text-slate-900 mb-2 md:mb-4 italic">No consultório (Cerejeiras)</h3><p className="text-sm md:text-base text-slate-700 font-light">Atendimento Presencial</p>
                </button>
              </div>
            </div>
          )}

          {step === 'datetime' && (
            <div className="fade-in w-full">
              <iframe
                width='100%'
                height='750px'
                src='https://psicanalistamessiastavares.zohobookings.com/portal-embed#/4742703000000048054'
                frameBorder='0'
                allowFullScreen
              />
            </div>
          )}

          {step === 'info' && (
            <div className="fade-in max-w-xl mx-auto space-y-6 md:space-y-8">
              <div className="space-y-2 md:space-y-3">
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold ml-2">Nome Completo</label>
                <input type="text" placeholder="Nome" value={patientData.name} onChange={e => setPatientData({ ...patientData, name: e.target.value })} className="w-full p-4 md:p-8 rounded-2xl md:rounded-[35px] bg-slate-50 border border-slate-100 outline-none text-base md:text-lg" />
              </div>
              <div className="space-y-2 md:space-y-3">
                <label className="text-[10px] uppercase tracking-widest text-slate-400 font-bold ml-2">Seu E-mail</label>
                <input type="email" placeholder="exemplo@email.com" value={patientData.email} onChange={e => setPatientData({ ...patientData, email: e.target.value })} className="w-full p-4 md:p-8 rounded-2xl md:rounded-[35px] bg-slate-50 border border-slate-100 outline-none text-base md:text-lg" />
              </div>
              <div className="space-y-2 md:space-y-3">
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold ml-2">WhatsApp</label>
                <input type="tel" placeholder="(11) 99999-9999" value={patientData.phone} onChange={e => setPatientData({ ...patientData, phone: e.target.value })} className="w-full p-4 md:p-8 rounded-2xl md:rounded-[35px] bg-slate-50 border border-slate-100 outline-none text-base md:text-lg" />
              </div>
              <div className="space-y-2 md:space-y-3">
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold ml-2">Motivo da Consulta (Opcional)</label>
                <textarea rows={3} placeholder="Conte um pouco sobre o que te traz à análise..." value={patientData.reason} onChange={e => setPatientData({ ...patientData, reason: e.target.value })} className="w-full p-6 md:p-8 rounded-2xl md:rounded-[35px] bg-slate-50 border border-slate-100 outline-none text-sm md:text-base resize-none" />
              </div>
              <label className="flex items-start gap-4 p-6 md:p-10 rounded-2xl md:rounded-[45px] bg-slate-900 text-white cursor-pointer active:scale-[0.98] transition-transform">
                <input type="checkbox" className="mt-1 rounded border-white/20 text-slate-900" checked={patientData.agreeToLgpd} onChange={e => setPatientData({ ...patientData, agreeToLgpd: e.target.checked })} />
                <span className="text-xs md:text-sm text-white/90 leading-relaxed font-light italic">Li e aceito as condições de sigilo e LGPD.</span>
              </label>
              <button disabled={!patientData.name || !patientData.phone || !patientData.email || !patientData.agreeToLgpd} onClick={handleNext} className="w-full bg-slate-900 text-white py-5 md:py-8 rounded-full font-bold text-base md:text-lg shadow-xl active:scale-[0.98] transition-all disabled:opacity-30">Prosseguir para Pagamento</button>
            </div>
          )}

          {step === 'payment' && (
            <div className="fade-in max-w-xl mx-auto text-center">
              {!paymentMethod ? (
                <div className="space-y-8">
                  <div className="text-center">
                    <h3 className="text-2xl font-serif text-slate-900 mb-2">Escolha como pagar</h3>
                    <p className="text-sm text-slate-500 font-light">Sua reserva será confirmada após o pagamento.</p>
                  </div>

                  <div className="grid gap-4">
                    <button
                      onClick={() => setPaymentMethod('pix')}
                      className="flex items-center justify-between p-6 md:p-8 bg-slate-50 rounded-3xl border border-slate-100 hover:border-slate-300 transition-all group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm">
                          <svg className="w-6 h-6 text-emerald-600" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" /></svg>
                        </div>
                        <div className="text-left">
                          <p className="font-bold text-slate-900">PIX</p>
                          <p className="text-[10px] text-slate-400 uppercase font-bold tracking-tighter">Confirmação imediata</p>
                        </div>
                      </div>
                      <svg className="w-5 h-5 text-slate-300 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                    </button>

                    <button
                      onClick={prepareMercadoPago}
                      className="flex items-center justify-between p-6 md:p-8 bg-[#009EE3]/5 rounded-3xl border border-[#009EE3]/10 hover:border-[#009EE3]/30 transition-all group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm p-2">
                          <img src="https://logodownload.org/wp-content/uploads/2019/06/mercado-pago-logo.png" alt="Mercado Pago" className="object-contain" />
                        </div>
                        <div className="text-left">
                          <p className="font-bold text-slate-900">Cartão de Crédito / MP</p>
                          <p className="text-[10px] text-slate-400 uppercase font-bold tracking-tighter">Até 12x ou saldo MP</p>
                        </div>
                      </div>
                      <svg className="w-5 h-5 text-[#009EE3] group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-6 md:space-y-10">
                  <div className="flex justify-center">
                    <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center border border-slate-100">
                      {paymentMethod === 'mercadopago' ? (
                        <img src="https://http2.mlstatic.com/static/org-img/mkt/pdp-v2/mercadopago.svg" className="w-10" alt="MP" />
                      ) : (
                        <svg className="w-10 h-10 text-emerald-600" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" /></svg>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-xl md:text-3xl font-serif font-bold italic">Confirmar Reserva</h3>
                    <div className="bg-slate-50 p-6 md:p-10 rounded-3xl md:rounded-[40px] space-y-4 text-left border border-slate-100">
                      <div className="flex justify-between items-center pb-4 border-b border-slate-200">
                        <span className="text-slate-500 font-light">Serviço</span>
                        <span className="font-bold text-slate-900">{selectedService?.name}</span>
                      </div>
                      <div className="flex justify-between items-center pb-4 border-b border-slate-200">
                        <span className="text-slate-500 font-light">Data e Hora</span>
                        <span className="font-bold text-slate-900">{selectedDate} às {selectedTime}</span>
                      </div>
                      <div className="flex justify-between items-center pt-2">
                        <span className="text-slate-900 font-serif text-lg">Total</span>
                        <span className="text-2xl font-serif font-bold text-slate-900">R$ {selectedService?.price}</span>
                      </div>
                    </div>
                  </div>

                  {paymentMethod === 'mercadopago' && mpInitPoint && (
                    <div className="animate-fade-in space-y-4">
                      <button
                        onClick={() => MercadoPagoService.openCheckout(mpInitPoint)}
                        className="w-full py-5 md:py-8 bg-[#009EE3] text-white rounded-full font-bold text-base md:text-lg shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-3"
                      >
                        Pagar com Mercado Pago
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                      </button>
                      <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Clique acima para abrir o checkout seguro</p>

                      <button
                        onClick={handleFinalize}
                        className="w-full py-4 text-slate-600 font-bold text-sm underline opacity-50 hover:opacity-100 transition-opacity"
                      >
                        Já realizei o pagamento
                      </button>
                    </div>
                  )}

                  {(paymentMethod === 'pix' || (paymentMethod === 'mercadopago' && isProcessingPayment)) && (
                    <button
                      onClick={handleFinalize}
                      disabled={isProcessingPayment}
                      className="w-full py-5 md:py-8 bg-slate-900 text-white rounded-full font-bold text-base md:text-lg shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-3"
                    >
                      {isProcessingPayment ? (
                        <>
                          <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                          Processando...
                        </>
                      ) : 'Confirmar e Agendar'}
                    </button>
                  )}

                  <div className="bg-amber-50 p-6 rounded-3xl text-left border border-amber-100">
                    <p className="text-[10px] text-amber-800 font-bold uppercase tracking-widest mb-1">Política de Cancelamento</p>
                    <p className="text-xs text-amber-700 italic font-light leading-relaxed">{CANCELLATION_POLICY}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-12 flex justify-center">
            <button onClick={handleBack} className="px-6 py-4 text-slate-400 hover:text-slate-900 text-[10px] font-bold uppercase tracking-widest transition-all">
              {currentIndex === 0 ? 'Cancelar' : 'Voltar'}
            </button>
          </div>
        </div>
      </div>
    </div >
  );
};

export default BookingWizard;
