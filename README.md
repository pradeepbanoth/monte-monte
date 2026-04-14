📊 NSE 3D Monte Carlo Risk Simulator

A high-performance, production-grade financial simulation tool built using React that visualizes stock price uncertainty in 3D using Monte Carlo methods.

Designed for traders, quants, and finance enthusiasts, this app combines advanced mathematical modeling with a clean, interactive UI.

🚀 Features

🔹 Core Engine

✅ Geometric Brownian Motion (GBM) with Ito Correction

✅ Monte Carlo simulation with configurable paths (100–5000+)

✅ Realistic NSE trading assumptions (252 days/year)

✅ Circuit breaker logic for Indian markets


🔹 Risk Analytics

📉 Value at Risk (VaR) & Conditional VaR (CVaR)

📊 Sharpe Ratio, Sortino Ratio, Calmar Ratio

📉 Maximum Drawdown & Risk of Ruin

📈 Expected Value (EV) & Kelly Criterion


🔹 Trading Insights

🎯 Target & Stop-loss probability tracking

📊 Probability of Profit

💰 Net P&L (with SEBI 2024 transaction costs)

⚖️ Risk-Reward analysis


🔹 Visualization

🌐 Interactive 3D Plotly fan chart

📊 Terminal distribution histogram

📈 Percentile paths (P1, P5, P50, P95, etc.)

🎨 Color-coded bullish/bearish scenarios


🔹 Indian Market Focus 🇮🇳

Preloaded presets:

.NIFTY 50, BANKNIFTY, SENSEX

.Reliance, TCS, Infosys, SBI, etc.

.Integrated:

.SEBI transaction costs

.RBI risk-free rate (6.5%) 


🧠 Mathematical Model

The simulator is based on:

        𝑆(𝑡+1) = 𝑆(𝑡) ⋅ exp⁡((𝜇−1/2.𝜎^2)𝑑𝑡 + 𝜎.𝑑𝑡^1/2.𝑍)


Where:

    μ → Expected return

     σ → Volatility

     Z → Random normal variable

     dt = 1/252


🛠️ Tech Stack

  Frontend: React (Hooks-based architecture)

   Visualization: Plotly.js (3D rendering)

   Math Engine: Custom Monte Carlo simulation (optimized)

  Styling: Inline styles + minimal UI system


⚙️ Installation

# Clone the repository
      
       git clone https://github.com/your-username/nse-monte-carlo-3d.git

       # Navigate into the project
       
       cd nse-monte-carlo-3d

      # Install dependencies
      
       npm install

       # Start development server
        
        npm start


▶️ How to Use

  
   Select a stock/index preset
   
    Enter:
  
    Entry price
   
    Stop-loss
   
    Target
   
    Adjust:
    
    Volatility
     
     Expected return
  
    Simulation days
 
 Click:
   
   ▶ RUN SIMULATION
  
   📊 Output Metrics
   
  Expected Price
    Net Profit/Loss (after costs)
    Probability of Profit
    Target / Stop-hit probability
     Risk Score (0–100)
Full distribution percentiles        
